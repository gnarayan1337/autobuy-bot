// Exercise the actual injected offer reader and worker in offline Chrome.
// All navigation is fulfilled locally. The profile and cart disappear on close.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {cartConfirmation} from '../extension/sony-cart/page.js';

const origin='https://direct.playstation.com/en-us/buy-consoles/';
const pro=origin+'playstation5-pro-console', base=origin+'playstation5-console-1-tb';
const proSku='1000050805', baseSku='1000049888';
const ext='chrome-extension://fixture/';
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try {
  const ctx=await browser.newContext({offline:true,serviceWorkers:'block'});
  let state='unavailable', signed=true, frozen=false, reloads=0, clicks=0, doc=0, stallReload=false;
  let reportedURL=pro, switched=false, requestMethods=[];
  function listing(url=pro){
    const isBase=url===base, id=isBase?baseSku:proSku;
    return '<h1>'+(isBase?'PlayStation®5 Console - 1 TB':'PlayStation®5 Pro Console')+'</h1><link rel="canonical" href="'+url+'">'+
      (signed?'<a class="js-topnav-desktop-signout-link">Sign out</a>':'<a class="js-topnav-desktop-signin-link">Sign in</a>')+
      '<main itemtype="https://schema.org/Product"><meta itemprop="sku" content="'+id+'">'+
      '<producthero-info><div class="js-currently-unavailable-wrpr" '+(['unavailable','conflict'].includes(state)?'':'hidden')+'>Currently Unavailable</div>'+
      '<button class="add-to-cart" data-product-code="'+id+'" '+(['ready','conflict'].includes(state)?'':'hidden')+
      ' onclick="document.querySelector(\'.js-mini-cart-count\').textContent=\'1\';window.recordAdd()">Add</button></producthero-info></main>'+
      '<span class="js-mini-cart-count">0</span><aside>Related items <button>Add</button></aside>';
  }
  await ctx.route('**/*',r=>{
    requestMethods.push(r.request().method());
    return [pro,base].includes(r.request().url())?r.fulfill({contentType:'text/html; charset=utf-8',body:listing(r.request().url())}):r.abort();
  });
  const page=await ctx.newPage();
  page.on('framenavigated',f=>{if(f===page.mainFrame())doc++;});
  await page.exposeFunction('recordAdd',()=>{clicks++;});
  const other=await ctx.newPage();await other.bringToFront();
  const event=()=>({addListener(f){this.fn=f;}});
  const messages=event(),alarm=event(),updated=event(),removed=event();
  const db={},durable={},notifications=[];
  function storage(data){return {
    get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),
    set:async patch=>Object.assign(data,structuredClone(patch)),
    remove:async keys=>{for(const k of [].concat(keys))delete data[k];},
  };}
  let period=0,discardable=true;
  globalThis.fetch=async()=>assert.fail('No background stock fetch is allowed');
  globalThis.chrome={
    runtime:{id:'fixture',getURL:s=>ext+s,onMessage:messages},
    storage:{local:storage(durable),session:storage(db)},
    action:{setBadgeText:async()=>{}},notifications:{create:async id=>{notifications.push(id);}},
    alarms:{onAlarm:alarm,create:async(_,opts)=>{period=opts.periodInMinutes;},clear:async()=>{}},
    tabs:{onUpdated:updated,onRemoved:removed,get:async()=>({url:reportedURL,frozen,status:'complete',autoDiscardable:discardable}),
      update:async(_,opts)=>{assert.deepEqual(Object.keys(opts),['autoDiscardable']);discardable=opts.autoDiscardable;}},
    scripting:{executeScript:async({target,func,args})=>{
      assert.equal(target.tabId,5);
      if(target.documentIds)assert.deepEqual(target.documentIds,[String(doc)]);
      if(switched && args[0]==='add') await page.locator('producthero-info button').evaluate(b=>b.disabled=true);
      if(stallReload && args[0]==='reload-unavailable'){reloads++;return [{documentId:String(doc),result:{state:'reloading'}}];}
      const navigation=args[0]==='reload-unavailable'?page.waitForEvent('domcontentloaded'):null;
      const result=await page.evaluate(({fn,args})=>Function('return ('+fn+')')()(...args),{fn:func.toString(),args});
      if(navigation){await navigation;reloads++;}
      return [{documentId:String(doc),result}];
    }},
  };
  const send=(msg,sender)=>new Promise(resolve=>messages.fn(msg,sender,resolve));
  await page.exposeFunction('wakeWorker',m=>send(m,{id:'fixture',url:page.url(),frameId:0,tab:{id:5}}));
  await page.addInitScript(()=>{window.chrome.runtime={sendMessage:m=>window.wakeWorker(m)};});
  await import('../extension/sony-cart/worker.js');
  const command=type=>send({type,tabId:5},{url:ext+'popup.html'});
  const poll=()=>alarm.fn({name:'maintain'});
  await page.goto(pro);
  const initial=await command('arm');
  assert.equal(initial.armed,true,initial.note);assert.equal(discardable,false);assert.equal(period,3/60);
  stallReload=true;await poll();await poll();assert.equal(reloads,1,'one reload per document');
  stallReload=false;await page.reload();
  await poll();await poll();assert.equal(reloads,3,'successive unavailable documents reload');
  const before=reloads;
  for(const [copy,detail] of [['The line is paused.','paused'],['Your estimated wait time is: 12 minutes','estimate'],['It is your turn','turn_prompt'],['Verify that you are human','verification']]){
    await page.setContent(listing()+'<h2>'+copy+'</h2>');await poll();
    assert.equal(db.pageReading.state,detail);assert.equal(reloads,before);assert.equal(clicks,0);
  }
  reportedURL='https://example.invalid/wait';await poll();assert.equal(db.pageReading.state,'off_listing');reportedURL=pro;
  frozen=true;await poll();frozen=false;assert.equal(db.pageReading.state,'frozen');
  for(const kind of ['loading','conflict','signed_out','wrong SKU','disabled']){
    state=kind==='signed_out'||kind==='wrong SKU'||kind==='disabled'?'ready':kind;signed=kind!=='signed_out';
    let body=listing();if(kind==='wrong SKU')body=body.replaceAll(proSku,baseSku);
    if(kind==='disabled')body=body.replace('class="add-to-cart"','disabled class="add-to-cart"');
    await page.setContent(body);await poll();assert.equal(clicks,0);assert.equal(reloads,before);
  }
  signed=true;state='unavailable';await page.setContent(listing());await poll();
  updated.fn(5,{status:'complete'});await command('status');
  state='ready';await page.locator('producthero-info').evaluate(el=>{
    el.querySelector('div').hidden=true;el.querySelector('button').hidden=false;
  });
  // Let the DOM observer itself wake the worker, without an alarm or page event.
  for(let i=0;i<100 && db.arm;i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(clicks,1);assert.equal(db.arm,undefined);assert.equal(discardable,true);
  assert.equal(durable.attempt.sku,proSku);assert.match(db.note,/acknowledged/);
  assert.ok(durable.events.some(e=>e.event==='product_page_returned'));
  assert.equal(durable.events.filter(e=>e.event==='in_stock').length,1);
  assert.ok(durable.events.some(e=>e.event==='add_acknowledged'));
  updated.fn(5,{status:'complete'});await poll();assert.equal((await command('arm')).ok,false);assert.equal(clicks,1);
  // Independent simulated profile: a ready button that changes before the click.
  delete durable.attempt;switched=true;await page.setContent(listing());await command('arm');
  assert.equal(clicks,1);assert.equal(db.arm,undefined);assert.match(db.note,/changed before Add/);
  switched=false;delete durable.attempt;
  await page.goto(base);reportedURL=base;
  assert.equal((await command('arm')).ok,false);
  assert.equal((await command('test-base')).ok,true);
  assert.equal(durable.baseCartTrial.result,'acknowledged');assert.equal(clicks,2);
  assert.equal((await command('test-base')).ok,false);assert.equal(clicks,2);assert.equal(durable.attempt,undefined);
  await page.setContent('<aside><button aria-label="Close cart"></button><button>Edit and Checkout</button><p>PlayStation®5 Console - 1 TB $649.00 Qty: 1</p></aside>');
  const cartLine=async model=>page.evaluate(({fn,model})=>Function('return ('+fn+')')()(null,model),{fn:cartConfirmation.toString(),model});
  assert.equal(await cartLine('base'),true);assert.equal(await cartLine('pro'),false);
  await page.locator('p').evaluate(el=>{el.innerText='PlayStation®5 Pro Console $899.00 Qty: 2. Accessories Qty: 1';});
  assert.equal(await cartLine('pro'),false);
  await page.locator('p').evaluate(el=>{el.innerText='PlayStation®5 Pro Console $899.00 Qty: 1';});
  assert.equal(await cartLine('pro'),true);
  assert.ok(requestMethods.every(m=>m==='GET'));
  console.log('Passed repeated unavailable-page reloads, queue and verification holds, background DOM wake, one exact-SKU Pro Add, acknowledgement, duplicate protection and separate base cart-only test. No background fetch or checkout.');
} finally {await browser.close();}
