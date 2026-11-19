// A headed, sandboxed Chrome with locally fulfilled fixture pages. No Sony requests.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {sonyPage} from '../extension/sony-cart/page.js';
// A private pipe to a disposable browser lets us opt out of Playwright's focus
// emulation. There is no debugging port and no connection to the user's Chrome.
const profile=await mkdtemp(path.join(tmpdir(),'ps-background-fixture-'));
const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--user-data-dir='+profile,'--remote-debugging-pipe','--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],
  {stdio:['ignore','ignore','ignore','pipe','pipe']});
const closed=once(child,'exit');
let buffer='';
const transport={
  send(msg){child.stdio[3].write(JSON.stringify(msg)+'\0');},
  close(){child.stdio[3].end();},
};
child.stdio[4].setEncoding('utf8').on('data',chunk=>{
  buffer+=chunk;
  for(let i;(i=buffer.indexOf('\0'))>=0;){
    const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
    transport.onmessage?.(msg);
  }
}).on('end',()=>transport.onclose?.());
let browser;
const url='https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console';
try {
  browser=await chromium.connectOverCDP(transport,{noDefaults:true,timeout:10000});
  const ctx=browser.contexts()[0];
  const requests=[];
  const html=`<!doctype html><meta charset=utf-8><link rel=canonical href="${url}"><h1>PlayStation®5 Pro Console</h1>
  <div class=js-topnav-desktop-profile-icon>My Account</div><span class=js-profile-menu-username hidden>Local fixture</span>
  <section itemscope itemtype="https://schema.org/Product"><meta itemprop=sku content=1000050805><div itemscope itemtype="https://schema.org/Offer"><link itemprop=availability href="https://schema.org/InStock"></div>
  <producthero-info><fieldset><button id=pro type=button class=add-to-cart aria-label="Add to Cart" data-product-code=1000050805>Add</button></fieldset></producthero-info></section>
  <span class=js-mini-cart-count>0</span><script>window.clicks=0;document.getElementById('pro').onclick=()=>{window.clicks++;document.querySelector('.js-mini-cart-count').textContent=String(window.clicks)};</script>`;
  await ctx.route('**/*',r=>{
    requests.push(r.request().method());
    return r.request().url()===url?r.fulfill({contentType:'text/html; charset=utf-8',body:html}):r.abort();
  });
  const listing=ctx.pages()[0] || await ctx.newPage();await listing.goto(url);
  const newTab=ctx.waitForEvent('page');
  await listing.evaluate(()=>{const a=document.createElement('a');a.href='about:blank';a.target='_blank';a.textContent='Local foreground tab';document.body.prepend(a);});
  await listing.getByText('Local foreground tab',{exact:true}).click();
  const other=await newTab;
  await other.bringToFront();
  const focus=()=>listing.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}));
  await other.setContent('<input id="work" aria-label="Local foreground work">');
  await other.locator('#work').click();
  const debug=await browser.newBrowserCDPSession();
  const windows=[];
  for (const p of [listing,other]) {
    const c=await ctx.newCDPSession(p);
    const {targetInfo}=await c.send('Target.getTargetInfo');
    windows.push((await debug.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId})).windowId);
  }
  assert.equal(windows[0],windows[1],'fixture must use two tabs in one real window');
  const beforeFocus=await focus();
  assert.equal(beforeFocus.visibility,'hidden');
  assert.equal(await other.evaluate(()=>document.visibilityState),'visible');
  const cases=[
    ['hidden',b=>b.hidden=true],['display none',b=>b.style.display='none'],
    ['visibility hidden',b=>b.style.visibility='hidden'],['disabled',b=>b.disabled=true],
    ['ARIA disabled',b=>b.setAttribute('aria-disabled','true')],
    ['disabled fieldset',b=>b.parentElement.disabled=true],['inert ancestor',b=>b.parentElement.inert=true],
    ['transparent ancestor',b=>b.parentElement.style.opacity='0'],
    ['zero size',b=>b.style.cssText='width:0;height:0;padding:0;border:0;overflow:hidden'],
    ['pointer events disabled',b=>b.style.pointerEvents='none'],
  ];
  for (const [name,alter] of cases) {
    const b=listing.locator('#pro');
    await b.evaluate(alter);
    const state=(await listing.evaluate(sonyPage,'add')).state;
    assert.equal(state,'loading',name);
    assert.equal(await listing.evaluate(()=>window.clicks),0,name);
    await b.evaluate(b=>{
      b.removeAttribute('style');b.hidden=false;b.disabled=false;b.removeAttribute('aria-disabled');
      b.parentElement.disabled=false;b.parentElement.inert=false;b.parentElement.removeAttribute('style');
    });
  }
  assert.equal((await listing.evaluate(sonyPage,'add')).state,'clicked');
  assert.deepEqual(await listing.evaluate(()=>[window.clicks,document.querySelector('.js-mini-cart-count').innerText]),[1,'1']);
  const afterFocus=await focus();
  assert.equal(afterFocus.visibility,'hidden');
  assert.equal(await other.evaluate(()=>document.visibilityState),'visible');
  assert.deepEqual(requests,['GET']);
  console.log(JSON.stringify({beforeFocus,afterFocus,foregroundTabStayedVisible:true,blockedCases:cases.length,clicksWhenBlocked:0,clicksWhenEnabled:1,network:'local fixture only'}));
} finally {
  await browser?.close().catch(()=>{});
  child.kill('SIGTERM');
  await closed;
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
