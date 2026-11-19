#!/usr/bin/env python3
"""Chrome native messaging bridge to the local watch. No network access or cart credentials."""
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".runtime" / "ps-direct"
MANIFEST = ROOT / "extension" / "sony-cart" / "manifest.json"
HOST = "com.pswatch.sony_cart"
SKU = "1000050805"
FRAME = struct.Struct("=I")
MAX_MESSAGE = 4096


def origin():
    key = base64.b64decode(json.loads(MANIFEST.read_text())["key"], validate=True)
    identifier = hashlib.sha256(key).hexdigest()[:32].translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))
    return "chrome-extension://" + identifier + "/"


def install(write):
    launcher = WORK / "chrome-native-host"
    file = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / (HOST + ".json")
    spec = dict(name=HOST, description="Read local PS5 Pro stock and reserve one cart attempt",
                path=str(launcher), type="stdio", allowed_origins=[origin()])
    if write:
        if file.exists() and json.loads(file.read_text()) != spec:
            raise SystemExit("An existing native host of this name has different settings.")
        WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
        launcher.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " -I -B " +
                            shlex.quote(str(Path(__file__).resolve())) + ' "$@"\n')
        launcher.chmod(0o700)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(spec, indent=2) + "\n")
        file.chmod(0o600)
    print(json.dumps({"installed": write, "file": str(file), "manifest": spec}, indent=2))


def stock():
    try:
        s = json.loads((WORK / "state.json").read_text())
    except (OSError, ValueError):
        return {"type": "stock", "stock": "unknown", "phase": "no_monitor"}
    if s.get("sku") != SKU:
        return {"type": "stock", "stock": "unknown", "phase": "no_reading"}
    if s.get("phase") == "watching":
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(s["checkedAt"])).total_seconds()
        except (KeyError, TypeError, ValueError):
            age = float("inf")
        if age > max(45, 3 * s.get("intervalSeconds", 3)):
            return {"type": "stock", "stock": "unknown", "phase": "stale_monitor"}
    return {k: s.get(k) for k in ("stock", "phase", "checkedAt", "sku")} | {"type":"stock"}


def claim(timestamp):
    state = stock()
    if not timestamp or state.get("checkedAt") != timestamp or state.get("stock") != "available" or state.get("phase") != "alerted":
        return False
    try:
        # Same exclusive file as the dedicated Chrome helper. Never retry an uncertain click.
        fd = os.open(WORK / "cart-attempt.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as out:
        json.dump({"sku": SKU, "source": "armed Chrome tab", "restockAt": timestamp}, out)
        out.flush()
        os.fsync(out.fileno())
    return True


def send(message):
    raw = json.dumps(message, separators=(",", ":")).encode()
    sys.stdout.buffer.write(FRAME.pack(len(raw)) + raw)
    sys.stdout.buffer.flush()


def bridge():
    """Serve Chrome's length-prefixed messages using the local watch and claim files."""
    previous = None
    buffered = bytearray()
    while True:
        state = stock()
        if state != previous:
            send(state)
            previous = state
        ready, _, _ = select.select([0], [], [], 0.5)
        if not ready:
            continue
        chunk = os.read(0, MAX_MESSAGE + 4)
        if not chunk:
            return
        buffered.extend(chunk)
        while len(buffered) >= FRAME.size:
            size, = FRAME.unpack_from(buffered)
            if not 0 < size <= MAX_MESSAGE:
                return
            if len(buffered) < size + FRAME.size:
                break
            request = json.loads(bytes(buffered[4:4 + size]))
            del buffered[:4 + size]
            if not isinstance(request, dict):
                return
            if request.get("type") == "claim" and isinstance(request.get("id"), str):
                send({"type":"claim", "id":request["id"][:80], "ok":claim(request.get("checkedAt"))})


if __name__ == "__main__":
    if sys.argv[1:2] in (["--install"], ["--preview"]):
        install(sys.argv[1] == "--install")
    elif sys.argv[1:2] == [origin()]:
        try:
            WORK.mkdir(mode=0o700, parents=True, exist_ok=True)
            with (WORK / "extension-port.lock").open("a") as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                bridge()
        except (BrokenPipeError, ValueError, OSError):
            sys.exit(1)
    else:
        sys.exit("Use --preview or --install; Chrome launches the host for its registered origin.")
