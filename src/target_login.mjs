// Manual login only. No credential collection, shopping clicks, or request logs.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { withTargetSession } from './target_session.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node src/target_login.mjs [--channel chrome|chromium]\nSign in in the visible browser, then close its window to save the profile.');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--channel' || !['chrome', 'chromium'].includes(args[1]))) {
    throw new Error('Expected --channel chrome or --channel chromium.');
  }
  let config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  try { config = { ...config, ...JSON.parse(await readFile(new URL('../config.local.json', import.meta.url))) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const channel = args[1] ?? config.channel;
  await withTargetSession(chromium, {
    channel: channel === 'chromium' ? undefined : channel, headless: false,
    viewport: null, args: ['--window-size=1400,900'],
  }, async context => {
    const closed = new Promise(resolve => context.once('close', resolve));
    const close = () => { void context.close().catch(() => {}); };
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(config.productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => console.log('The initial page did not finish loading. You can navigate in the browser.'));
      console.log('Sign in directly on Target, set shipping ZIP 75013, then close this browser window when finished.');
      await closed;
    } finally {
      process.off('SIGTERM', close);
      process.off('SIGINT', close);
    }
  }, { requireExisting: false });
  console.log('Browser closed; the local profile was saved. Sign-in acceptance has not been independently verified.');
}

main().catch(error => {
  console.error(JSON.stringify({ event: 'login_browser_failed', kind: error.name }));
  process.exitCode = 1;
});
