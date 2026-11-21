import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withTargetSession } from '../src/target_session.mjs';
import { RunState } from '../src/state.mjs';

test('a missing saved profile is explicit and releases its lock without launching', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'target-session-'));
  try {
    await assert.rejects(withTargetSession({ launchPersistentContext: assert.fail }, {}, assert.fail, { runtime }), { name: 'TargetProfileMissing' });
    await assert.rejects(access(path.join(runtime, 'run.lock')), { code: 'ENOENT' });
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test('profile use shares the CLI lock and preserves purchase state even when the action fails', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'target-session-'));
  let closed = 0;
  const browser = { launchPersistentContext: async (directory, options) => {
    assert.equal(directory, path.join(runtime, 'browser'));
    assert.equal(options.headless, false);
    await access(path.join(runtime, 'run.lock'));
    return { close: async () => closed++ };
  } };
  try {
    await writeFile(path.join(runtime, 'state.json'), '{"phase":"needs-review"}');
    await assert.rejects(withTargetSession(browser, { headless: false }, async () => {
      await assert.rejects(new RunState(runtime).acquire(), /Another bot/);
      throw new Error('fixture failure');
    }, { runtime, requireExisting: false }), /fixture failure/);
    assert.equal(closed, 1);
    assert.equal(await readFile(path.join(runtime, 'state.json'), 'utf8'), '{"phase":"needs-review"}');
    await assert.rejects(access(path.join(runtime, 'run.lock')), { code: 'ENOENT' });
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test('an existing CLI lock is never removed by a second session process', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'target-session-'));
  const owner = new RunState(runtime);
  try {
    await owner.acquire();
    await assert.rejects(withTargetSession({ launchPersistentContext: assert.fail }, {}, assert.fail, { runtime, requireExisting: false }), /Another bot/);
    await access(path.join(runtime, 'run.lock'));
  } finally { await owner.release(); await rm(runtime, { recursive: true, force: true }); }
});

test('launch and close failures still release an owned session lock', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'target-session-'));
  try {
    for (const failLaunch of [true, false]) {
      const browser = { launchPersistentContext: async () => {
        if (failLaunch) throw new Error('fixture launch failure');
        return { close: async () => { throw new Error('fixture close failure'); } };
      } };
      await assert.rejects(withTargetSession(browser, {}, async () => {}, { runtime, requireExisting: false }), /fixture/);
      await assert.rejects(access(path.join(runtime, 'run.lock')), { code: 'ENOENT' });
    }
  } finally { await rm(runtime, { recursive: true, force: true }); }
});
