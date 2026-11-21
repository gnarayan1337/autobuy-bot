// Persistent-session handoff against a local server; no Target requests or credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { withTargetSession } from '../src/target_session.mjs';

const runtime = await mkdtemp(path.join(os.tmpdir(), 'target-session-browser-'));
const server = createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'fixture_session=local-only; HttpOnly; Max-Age=300; Path=/; SameSite=Lax' });
    res.end('<h1>Fixture sign-in</h1><script>localStorage.setItem("fixture", "present")</script>');
  } else {
    const signedIn = req.headers.cookie?.includes('fixture_session=local-only');
    res.writeHead(signedIn ? 200 : 401, { 'Content-Type': 'text/html' });
    res.end(signedIn ? '<h1>Fixture session accepted</h1>' : 'Fixture session missing');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { channel: process.argv.includes('--chromium') ? undefined : 'chrome', headless: true, serviceWorkers: 'block' };
try {
  const unrelated = await chromium.launch(options);
  try {
    const context = await unrelated.newContext();
    assert.equal((await context.request.get(origin + '/private')).status(), 401);
  } finally { await unrelated.close(); }
  await withTargetSession(chromium, options, async context => {
    await context.pages()[0].goto(origin + '/login');
  }, { runtime, requireExisting: false });
  await withTargetSession(chromium, options, async context => {
    const page = context.pages()[0];
    assert.equal((await page.goto(origin + '/private')).status(), 200);
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture')), 'present');
    const response = await context.request.get(origin + '/private', { maxRedirects: 0, maxRetries: 0 });
    assert.equal(response.status(), 200);
    await response.dispose();
  }, { runtime });
  console.log('Saved profile survives browser close; browser and HTTP client reuse the fixture session. A fresh session is rejected.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(runtime, { recursive: true, force: true });
}
