import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {observeShipping,stopObserver} from '../extension/target-shipping/shipping.js';

const url='https://www.target.com/p/playstation-5-pro-console/-/A-93620188', id='target-test';
const chromeBrowser=await chromium.launch({channel:'chrome',chromiumSandbox:true,headless:true});
try {
  const ctx=await chromeBrowser.newContext();
  const page=await ctx.newPage();
  await ctx.route('**/*',r=>r.request().url()===url?r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>PlayStation 5 Pro Console</h1>'}):r.abort());
  await page.goto(url);
  const fixture=({tile='',state='',pickup='Only 1 left',delivery='In stock',extra='',attrs=''}={})=>
    `<h1>PlayStation 5 Pro Console</h1><section aria-label="Fulfillment">
    <button>${pickup}</button><button>${delivery}</button>
    <button id="SHIPPING" class="${state}" aria-label="Shipping, selected" ${attrs}>Shipping <span>${tile}</span></button></section>
    <button>Add to cart</button><aside>In stock</aside>${extra}`;
  const a='styles_notActiveAndAvailableFulfillmentCell__wylMF', u='styles_activeAndUnavailableFulfillmentCell__XjAi0';
  await page.evaluate(()=>{window.chrome={runtime:{sendMessage:async()=>({})}};});
  for(const [props,expected] of [
    [{tile:'Not available',state:u},'unavailable'],[{tile:'Arrives by Friday'},'available'],
    [{tile:'Ships free',state:a,pickup:'Not available',delivery:'Not available'},'available'],
    [{tile:'Only 1 left'},'available'],[{tile:'Standard parcel'},'unknown'],
    [{state:a,tile:'loading…'},'unknown'],[{state:a,tile:'Not available'},'unavailable'],
    [{tile:'Arrives tomorrow',attrs:'disabled'},'unknown'],[{tile:'Notify me when back in stock'},'unknown'],
    [{tile:'Arrives tomorrow',extra:'<div role="dialog">Verify you are human</div>'},'attention'],
    [{tile:'Only 1 left',extra:'<div>Quick verification</div>'},'attention'],
    [{tile:'Only 1 left',extra:'<iframe title="Human verification"></iframe>'},'attention'],
    [{tile:'Only 1 left',extra:'<iframe id="px-captcha-modal"></iframe>'},'verification'],
    [{tile:'Only 1 left',extra:'<iframe srcdoc="<title>Bot challenge</title>"></iframe>'},'attention'],
    [{tile:'Only 1 left',extra:'<div role="alert" aria-label="bot verification challenge">Please verify</div>'},'attention'],
    [{tile:'Only 1 left',extra:'<div hidden>Quick verification</div><iframe hidden title="Quick verification"></iframe>'},'available'],
    [{tile:'Only 1 left',extra:'<p>Learn about quick verification options.</p>'},'available'],
  ]) {
    await page.setContent(fixture(props));
    assert.equal((await page.evaluate(observeShipping,'fixture')).state,expected);
  }
  await page.evaluate(stopObserver,'fixture');
  const baseUrl='https://www.target.com/p/playstation-5-console-digital-edition/-/A-94961316';
  const base=await ctx.newPage();
  await base.route(baseUrl,r=>r.fulfill({contentType:'text/html; charset=utf-8',body:
    fixture({tile:'Arrives by Friday', state:a}).replace('PlayStation 5 Pro Console','PlayStation 5 Console - Digital Edition')}));
  await base.goto(baseUrl);
  assert.equal((await base.evaluate(observeShipping,null)).state,'away');
  const baseSample=await base.evaluate(fn=>Function('return ('+fn+')')()(null,'base'),observeShipping.toString());
  assert.equal(baseSample.state,'available');
  assert.equal(await base.evaluate(()=>!!window.__ps5ProTargetShipping),false);
  await base.close();
  const {storage,backend}=(()=>{
    const backend={};
    return {backend,storage:{get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in backend).map(k=>[k,structuredClone(backend[k])])),
      set:async patch=>Object.assign(backend,structuredClone(patch)), remove:async k=>{delete backend[k];}}};
  })();
  const event=()=>({addListener(fn){this.fn=fn;}});
  const messages=event(), alarm=event(), changed=event(), removed=event();
  let notifications=[], reloads=0, period=0, canDiscard=true;
  const send=(m,sender)=>new Promise(resolve=>messages.fn(m,sender,resolve));
  await page.exposeFunction('reportToWorker',(msg)=>send(msg,{id,tab:{id:42},frameId:0,url}));
  await page.evaluate(()=>{chrome.runtime.sendMessage=msg=>window.reportToWorker(msg);});
  const durable={};
  globalThis.chrome={
    runtime:{id,getURL:p=>'chrome-extension://'+id+'/'+p,onMessage:messages},
    storage:{session:storage,local:{get:async()=>({...durable}),set:async o=>Object.assign(durable,o)}},
    action:{setBadgeText:async()=>{}}, notifications:{create:async(i,m)=>notifications.push([i,m.message])},
    alarms:{onAlarm:alarm,create:async(_,opts)=>{period=opts.periodInMinutes;},clear:async()=>{}},
    tabs:{onUpdated:changed,onRemoved:removed,get:async()=>({id:42,url,status:'complete',autoDiscardable:canDiscard}),
      reload:async()=>{reloads++;},update:async(i,o)=>{assert.equal(i,42);canDiscard=o.autoDiscardable;}},
    scripting:{executeScript:async({func,args,target})=>{assert.equal(target.tabId,42);return [{documentId:'fixture-doc',result:await page.evaluate(({fn,params})=>Function('return ('+fn+')')()(...params),{fn:func.toString(),params:args})}];}},
  };
  await import('../extension/target-shipping/worker.js');
  const command=(kind,tabId=42,extra={})=>send({kind,tabId,...extra},{id,url:chrome.runtime.getURL('popup.html')});
  const noticeMarkup='<div id="notice"><a role="button" tabindex="0" aria-label="Dismiss notice">Dismiss</a></div>';
  await page.setContent(fixture({tile:'Not available',state:u,extra:noticeMarkup}));
  await page.evaluate(()=>{
    window.noticeClicks=0;
    document.addEventListener('click',event=>{
      if(!event.target.matches('#notice > a')) return;
      window.noticeClicks++;
      if(!window.keepNoticeOpen) event.target.parentElement.hidden=true;
    });
  });
  await page.evaluate(observeShipping,null);
  assert.equal(await page.evaluate(()=>window.noticeClicks),0,'A one-shot read does not dismiss');
  await command('arm');
  assert.equal(await page.evaluate(()=>window.noticeClicks),1,'Already visible when armed');
  await page.locator('#notice a').evaluate(el=>{el.setAttribute('aria-disabled','true');el.parentElement.hidden=false;});
  alarm.fn({name:'check-shipping'});await command('status');
  assert.equal(await page.evaluate(()=>window.noticeClicks),1,'Disabled notice is left alone');
  await page.locator('#notice a').evaluate(el=>el.removeAttribute('aria-disabled'));
  await page.waitForFunction(()=>window.noticeClicks===2,null,{timeout:3000});
  await page.evaluate(()=>{window.keepNoticeOpen=true;document.querySelector('#notice').hidden=false;});
  await page.waitForFunction(()=>window.noticeClicks===3,null,{timeout:3000});
  alarm.fn({name:'check-shipping'});await command('status');
  assert.equal(await page.evaluate(()=>window.noticeClicks),3,'Repeated reads do not click a lingering control twice');
  await command('stop');
  await page.evaluate(html=>{document.querySelector('#notice').outerHTML=html;},noticeMarkup);
  alarm.fn({name:'check-shipping'});await command('status');
  assert.equal(await page.evaluate(()=>window.noticeClicks),3,'Stopped watcher never dismisses');
  console.log('Passed exact Dismiss notice control on arm and on reappearance, including disabled, repeated and stopped reads.');
  await page.setContent(fixture({tile:'Not available',state:u}));
  assert.equal((await command('arm',42,{reload:true})).reading.state,'unavailable');
  assert.equal(period,3/60); assert.equal(canDiscard,false);
  alarm.fn({name:'check-shipping'});await command('status');assert.equal(reloads,1);
  alarm.fn({name:'check-shipping'});await command('status');assert.equal(reloads,1,'Never reload the same document twice');
  // A change to pickup alone cannot alert. A later shipping change must alert once.
  await page.evaluate(()=>document.querySelector('section button').innerText='Available');
  await new Promise(r=>setTimeout(r,220));assert.equal(notifications.length,0);
  await page.evaluate(()=>{let e=document.querySelector('#SHIPPING');e.className='styles_activeAndAvailableFulfillmentCell__new';e.innerText='Shipping · Arrives tomorrow';});
  for(let i=0;i<60&&!notifications.length;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(notifications.length,1);assert.equal(backend.reading.state,'available');assert.equal(canDiscard,true);assert.ok(!backend.watch);
  alarm.fn({name:'check-shipping'});await command('status');assert.equal(reloads,1);
  // When the storefront replaces the product with either verification screen,
  // leave every control to the shopper, even with refresh and purchase enabled.
  for (const caption of ['Press & hold','Press again']) {
    await page.setContent(fixture({tile:'Not available',state:u}));
    await command('arm',42,{autoBuy:true,reload:true});
    const alertsBefore=notifications.length, reloadsBefore=reloads;
    await page.setContent('<h1>PlayStation 5 Pro Console</h1>'+noticeMarkup+'<main><div>Quick verification</div><p>Additional text may vary.</p>'+
      '<button aria-label="Accessible challenge"></button><button>'+caption+'</button></main>');
    await page.evaluate(()=>{
      window.verificationClicks=0;
      document.addEventListener('click',()=>{window.verificationClicks++;},{capture:true,once:true});
    });
    alarm.fn({name:'check-shipping'});
    const stopped=await command('status');
    assert.equal(stopped.reading.state,'attention');
    assert.match(stopped.reading.reason,/Complete Quick verification/);
    assert.equal(stopped.watch,undefined);
    assert.deepEqual(notifications.slice(alertsBefore).map(([id])=>id),['target-ps5-attention']);
    alarm.fn({name:'check-shipping'});await command('status');
    assert.equal(reloads,reloadsBefore);
    assert.equal(await page.evaluate(()=>window.verificationClicks),0);
    assert.ok(!durable.cartAttempt && !durable.orderAttempt);
  }
  console.log('Passed both Quick verification screens: watch disarmed, attention notification requested, zero clicks, reloads or purchase attempts after detection.');
  const cartPage=fixture({state:a,tile:'Arrives tomorrow'}).replace('Shipping, selected','Shipping,')
    .replace('<button>Add to cart</button>',`<header><a href="/account">Hi, Fixture</a><a href="/cart" aria-label="cart 0 items">Cart</a></header>
    <button aria-label="Add to cart PlayStation 5 Pro Console" id="pro-add">Add to cart</button>
    <button aria-label="Add to cart for PlayStation 5 Console (Slim)" id="wrong-add">Add to cart</button>`);
  await page.setContent(cartPage);
  await page.evaluate(()=>{
    window.proClicks=0;window.wrongClicks=0;window.selections=0;
    document.querySelector('#SHIPPING').onclick=e=>{window.selections++;e.currentTarget.setAttribute('aria-label','Shipping, selected');};
    document.querySelector('#wrong-add').onclick=()=>window.wrongClicks++;
    document.querySelector('#pro-add').onclick=()=>{window.proClicks++;document.querySelector('[href="/cart"]').setAttribute('aria-label','cart 1 item');};
  });
  // A currently enabled pickup item must never cause a cart click while shipping is unavailable.
  await page.locator('#SHIPPING').evaluate(e=>{e.className='styles_notActiveAndUnavailableFulfillmentCell__x';e.innerText='Shipping Not available';});
  await command('arm',42,{autoCart:true,reload:false});
  alarm.fn({name:'check-shipping'});await command('status');
  assert.equal(reloads,1,'passive mode must not reload');assert.equal(await page.evaluate(()=>window.proClicks),0);
  await page.locator('#SHIPPING').evaluate(e=>{e.className='styles_notActiveAndAvailableFulfillmentCell__x';e.innerText='Shipping Arrives tomorrow';});
  for(let i=0;i<100 && backend.reading?.state!=='added';i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(backend.reading.state,'added');
  assert.deepEqual(await page.evaluate(()=>[window.selections,window.proClicks,window.wrongClicks]),[1,1,0]);
  assert.equal(durable.cartAttempt.tcin,'93620188');
  assert.match((await command('arm',42,{autoCart:true})).error,/earlier Add/);
  console.log('Passed: passive watch, shipping selected before Add, exact Pro button, acknowledgement and restart-safe single attempt.');
  console.log('Passed: exact shipping tile, both availability classes, stock and loading copy, mixed fulfillment, access check, live tile update, background cadence and one timestamped alert.');
} finally {await chromeBrowser.close();}
