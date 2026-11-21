#!/usr/bin/env python3
"""Localhost-only browser display for a human Target login over an SSH tunnel."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.runtime' / 'remote'
TOOLS = ROOT / '.runtime' / 'tools'
STATE = WORK / 'processes.json'
DISPLAY = ':99'
WEB_PORT = 6080
VNC_PORT = 5901
VIEWER = 'http://localhost:6080/vnc.html?autoconnect=true&resize=scale'


def process_identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] in {'Z', 'X'} else fields[19]
    except (OSError, IndexError):
        return None


def running(record):
    return bool(record and record.get('started') and process_identity(record['pid']) == record['started'])


def save(state):
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(STATE)


def environment():
    return {**os.environ, 'DISPLAY': DISPLAY, 'XAUTHORITY': str(WORK / 'Xauthority'),
            'PLAYWRIGHT_BROWSERS_PATH': str(TOOLS / 'browsers')}


def node():
    binary = TOOLS / 'node' / 'bin' / 'node'
    if not binary.is_file():
        raise RuntimeError('The EC2 remote tools are not installed: missing dedicated Node executable.')
    return str(binary)


def launch(state, name, command):
    with (WORK / (name + '.log')).open('a') as output:
        child = subprocess.Popen(command, cwd=ROOT, env=environment(), stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=output, start_new_session=True)
    state[name] = {'pid': child.pid, 'started': process_identity(child.pid)}
    save(state)
    return child


def stop_process(state, name):
    record = state.get(name)
    if running(record):
        os.kill(record['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 12
        while running(record) and time.monotonic() < deadline:
            time.sleep(0.1)
        if running(record):
            raise RuntimeError(f'{name} has not closed; leaving its state intact. Check its private log.')
    state.pop(name, None)
    save(state)


def port_free(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise RuntimeError(f'Local port {port} is already in use; no existing service was changed.') from None


def wait_port(state, name, port):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not running(state.get(name)):
            break
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f'{name} did not start; check {WORK / (name + ".log")}.')


def status(state):
    print(json.dumps({'desktop': running(state.get('desktop')), 'viewer': running(state.get('viewer')),
                      'loginBrowser': running(state.get('login')), 'url': VIEWER, 'display': DISPLAY}))


def start(state):
    for binary in ['Xvnc', 'xauth', 'metacity']:
        if not shutil.which(binary):
            raise RuntimeError(f'Missing remote-display dependency: {binary}. See README EC2 setup.')
    proxy = TOOLS / 'remote-venv' / 'bin' / 'websockify'
    web = TOOLS / 'noVNC'
    if not proxy.is_file() or not (web / 'vnc.html').is_file():
        raise RuntimeError('Missing noVNC/websockify. See README EC2 setup.')
    node()
    if not running(state.get('desktop')):
        port_free(VNC_PORT)
        if Path('/tmp/.X99-lock').exists() or Path('/tmp/.X11-unix/X99').exists():
            raise RuntimeError('Display :99 is already reserved; it was not changed.')
        auth = WORK / 'Xauthority'
        auth.touch(mode=0o600, exist_ok=True)
        subprocess.run(['xauth', '-f', str(auth)], input=f'add {DISPLAY} . {secrets.token_hex(16)}\n',
                       text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
        launch(state, 'desktop', ['Xvnc', DISPLAY, '-geometry', '1440x960', '-depth', '24',
                                 '-rfbport', str(VNC_PORT), '-interface', '127.0.0.1', '-localhost',
                                 '-UseIPv6=0', '-SecurityTypes', 'None', '-AlwaysShared',
                                 '-nolisten', 'tcp', '-auth', str(auth)])
        wait_port(state, 'desktop', VNC_PORT)
    if not running(state.get('manager')):
        launch(state, 'manager', ['metacity', '--replace'])
    if not running(state.get('viewer')):
        port_free(WEB_PORT)
        launch(state, 'viewer', [str(proxy), '--web', str(web), '--heartbeat', '30',
                                f'127.0.0.1:{WEB_PORT}', f'127.0.0.1:{VNC_PORT}'])
        wait_port(state, 'viewer', WEB_PORT)
    if not running(state.get('login')):
        # The Node helper acquires the same lock as the CLI and diagnostic.
        if (ROOT / '.runtime' / 'run.lock').exists():
            raise RuntimeError('A Target profile process holds .runtime/run.lock. Close it before starting login.')
        launch(state, 'login', [node(), str(ROOT / 'src' / 'target_login.mjs'), '--channel', 'chromium'])
        time.sleep(1)
        if not running(state.get('login')):
            raise RuntimeError('The login browser did not start; check the private login.log.')
    status(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'status', 'finish-login', 'diagnose', 'stop'])
    args = parser.parse_args()
    if os.getuid() == 0:
        parser.error('Run this as your ordinary SSH user, without sudo.')
    os.umask(0o077)
    WORK.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (WORK / 'control.lock').open('a') as control:
        fcntl.flock(control, fcntl.LOCK_EX)
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
        if args.command == 'start':
            start(state)
        elif args.command == 'status':
            status(state)
        elif args.command in {'finish-login', 'diagnose'}:
            stop_process(state, 'login')
            if args.command == 'diagnose':
                if not running(state.get('desktop')):
                    raise RuntimeError('Start the remote display first.')
                # Release the supervisor lock; the diagnostic owns the profile lock.
                fcntl.flock(control, fcntl.LOCK_UN)
                result = subprocess.run([node(), 'src/diagnose.mjs', '--session', '--headed',
                                         '--channel', 'chromium', '--model', 'both', '--zip', '75013'],
                                        cwd=ROOT, env=environment())
                return result.returncode
            status(state)
        elif args.command == 'stop':
            for name in ['login', 'viewer', 'manager', 'desktop']:
                stop_process(state, name)
            status(state)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
