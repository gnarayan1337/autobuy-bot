import { chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunState } from './state.mjs';

const defaultRuntime = fileURLToPath(new URL('../.runtime/', import.meta.url));

// Use the CLI's lock and profile, without reading or modifying purchase state.
export async function withTargetSession(chromium, options, action, { runtime = defaultRuntime, requireExisting = true } = {}) {
  const state = new RunState(runtime);
  await state.acquire();
  let context;
  try {
    const profile = path.join(runtime, 'browser');
    if (requireExisting) {
      try {
        if (!(await stat(path.join(profile, 'Default'))).isDirectory()) {
          throw Object.assign(new Error('Missing Chromium profile directory'), { code: 'ENOENT' });
        }
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const missing = new Error('Create the dedicated browser profile with target:login or setup first.');
        missing.name = 'TargetProfileMissing';
        throw missing;
      }
    }
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(runtime, 0o700);
    await chmod(profile, 0o700);
    context = await chromium.launchPersistentContext(profile, options);
    return await action(context);
  } finally {
    try { await context?.close(); }
    finally { await state.release(); }
  }
}
