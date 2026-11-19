import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {checkoutPage, TARGET_ORDER} from '../extension/target-shipping/checkout.js';
import {observeShipping} from '../extension/target-shipping/shipping.js';
import {openSignedInFixture} from './signed_in_profile.mjs';

// Every URL is fulfilled locally. This profile has no Target account or payment.
const origin='https://www.target.com';
const proUrl=origin+'/p/playstation-5-pro-console/-/A-93620188';
const images={
  pro:'GUEST_403e3d4f-1b7b-4b33-a035-4e8aeba2d792',
  base:'GUEST_c12714d1-b136-41c9-9b43-5579ff0c08f8',
};
const image=model=>'<img width="50" height="50" alt="'+(model==='pro'?'PlayStation 5 Pro Console':'PlayStation 5 Console - Digital Edition')+' quantity 1" src="https://target.scene7.com/is/image/Target/'+images[model]+'?wid=60">';
const item=model=>'<a href="/p/-/A-'+(model==='pro'?'93620188':'94961316')+'">'+image(model)+
  (model==='pro'?'PlayStation 5 Pro Console':'PlayStation 5 Console - Digital Edition')+'</a>';
function cart({model='pro',quantity=1,count=1,method='Shipping',extra=false}={}) {
  return '<main><h1>Cart</h1><section><h2>Shipping</h2><p>to 75013</p><article>'+
    item(model)+'<div><button aria-label="Decrement">−</button><select><option selected>'+quantity+'</option></select><span>'+quantity+'</span><button aria-label="Increment">+</button></div>'+
    '<button>Save for later</button><label><input type="radio" checked>'+method+'</label>'+
    '<label><input type="checkbox" '+(extra?'checked':'')+'>Add protection plan (optional)</label></article></section>'+
    '<section><h2>Saved for later (1)</h2>'+item('pro')+'<button>Add to cart</button></section>'+
    '<aside><b>$974.24 est. total · '+count+' item</b><a href="/co-review">Check out</a><button>Apple Pay</button></aside></main>';
}
function checkout({model='pro',count=1,total='$974.24',zip='75013',card=true,method='Order by 5pm, get it tomorrow',button=true}={}) {
  return '<main><section><h2>Cart</h2><p>'+total+' total · '+count+' item</p><button>Edit</button>'+
    '<aside>Want your items faster? All your items are available for pickup at Allen <button>Change all to pickup</button></aside>'+
    '<p>'+method+'</p>'+image(model)+'</section><section><h2>Address</h2><p>Example City, TX, '+zip+'</p><span>Default address</span></section>'+
    '<section><h2>Order summary</h2><div><span>Subtotal ('+count+' item)</span> <span>$899.99</span></div>'+
    '<div><span>Shipping</span> <span>Free</span></div><div><span>Estimated taxes</span> <span>$74.25</span><small>Based on 75013</small></div>'+
    '<div><h3>Total</h3> <strong>'+total+'</strong></div>'+(card?'<p>'+total+'<br>Mastercard *0000</p>':'<p>Add payment method</p>')+
    '<button id="place" '+(button?'':'disabled')+' onclick="submitFixtureOrder()">Place your order</button></section></main>';
}
const product='<header><a href="/account">Hi, Fixture</a><a href="/cart" aria-label="cart 0 items">Cart</a></header>'+
  '<main><h1>PlayStation 5 Pro Console</h1><section aria-label="Fulfillment"><button id="SHIPPING" aria-pressed="true">Shipping Get it tomorrow</button></section>'+
  '<button aria-label="Add to cart for PlayStation 5 Pro Console" id="add" onclick="addFixtureItem()">Add to cart</button>'+
  '<aside role="dialog" hidden id="drawer"><h2>Added to cart</h2>Shipping · PlayStation 5 Pro Console'+
  '<button>Continue shopping</button><a href="/cart">View cart &amp; check out</a></aside></main>'+
  '<script>function addFixtureItem(){document.querySelector("#drawer").hidden=false;document.querySelector("header [href*=cart]").setAttribute("aria-label","cart 1 item");window.countClick("add");}</script>';
const receipt='<main><h1>Thank you for your order</h1><p>Order number: 1234567</p></main>';
function cvvDrawer(ending='0000') {
  return '<aside role="dialog" aria-modal="true"><h2>Confirm CVV</h2><p>Mastercard *'+ending+'</p>'+
    '<input type="password" autocomplete="cc-csc" placeholder="Enter CVV" oninput="this.parentElement.querySelector(\'button\').disabled=false">'+
    '<button disabled onclick="window.countClick(\'confirm\');location.href=\'/co-confirmation\'">Confirm</button>'+
    '<button>Pay another way instead</button></aside>';
}
const signedIn=process.argv.includes('--signed-in-profile')?await openSignedInFixture(chromium,origin):null;
const browser=signedIn?null:await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try {
  const ctx=signedIn?.context??await browser.newContext({offline:true,serviceWorkers:'block'});
  let shippingAvailable=true;
  const authenticatedPaths=new Set();
  let checkoutOptions={}, cartOptions={}, requireCode=false, drawerEnding='0000', clicks={add:0, order:0,confirm:0};
  await ctx.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin) return route.abort();
    if(signedIn){
      if(!await signedIn.isSignedIn(route.request())) return route.fulfill({status:401,body:'Fixture sign-in required'});
      authenticatedPaths.add(url.pathname);
    }
    const listing=shippingAvailable?product:product.replace('Shipping Get it tomorrow','Shipping Not available');
    const html=url.href===proUrl?listing:url.pathname==='/cart'?cart(cartOptions):
      url.pathname==='/co-review'?checkout(checkoutOptions)+'<script>function submitFixtureOrder(){window.countClick("order");'+
        (requireCode?'document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(cvvDrawer(drawerEnding))+')':'location.href="/co-confirmation"')+'}</script>':
      url.pathname==='/co-confirmation'?receipt:null;
    return html===null?route.abort():route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  const page=await ctx.newPage();
  await page.exposeFunction('countClick',what=>{clicks[what]++;});
  const tabId=43;
  let docId=0;
  page.on('framenavigated',f=>{if(f===page.mainFrame())docId++;});
  async function inject({func,args=[],target}) {
    assert.equal(target.tabId,tabId);
    if (target.documentIds && !target.documentIds.includes(String(docId))) throw Error('Old document.');
    const current=String(docId);
    const result=await page.evaluate(({fn,params})=>Function('return ('+fn+')')()(...params),{fn:func.toString(),params:args});
    return [{result,documentId:current}];
  }
  const probe=async(stage,proof,commit=false)=>(await inject({target:{tabId},func:checkoutPage,args:[stage,TARGET_ORDER,proof,commit]}))[0].result;
  if(signedIn){
    for(const [inStock,expected] of [[false,'unavailable'],[true,'available']]){
      shippingAvailable=inStock;
      const response=await page.goto(proUrl);
      assert.equal(response.status(),200,'The headless profile must remain signed in for each fresh read');
      assert.equal((await page.evaluate(observeShipping,null)).state,expected);
    }
  }
  await page.goto(origin+'/cart');
  const validCart=await probe('cart');
  assert.equal(validCart.state,'ready',validCart.reason);
  assert.deepEqual(validCart.proof,{tcin:TARGET_ORDER.tcin,images:[images.pro]});
  // The image can sit outside the quantity/name container on the real cart.
  await page.setContent(cart().replace(image('pro'),''));
  assert.deepEqual((await probe('cart',{primaryImage:images.pro})).proof,validCart.proof);
  for(const options of [{model:'base'},{quantity:2},{count:2},{method:'Order Pickup'},{extra:true}]) {
    await page.setContent(cart(options)); const rejected=await probe('cart',null,true);
    assert.equal(rejected.state,'review',JSON.stringify(options)+' '+rejected.reason);
    assert.equal(page.url(),origin+'/cart');
  }
  await page.goto(origin+'/co-review');
  const proof=validCart.proof;
  for (const panel of ['<div>Quick verification</div>','<iframe id="px-captcha-modal"></iframe>','<iframe aria-label="Quick verification"></iframe>',
    '<iframe srcdoc="<title>Human verification</title>"></iframe>','<iframe srcdoc="<title>Bot challenge</title>"></iframe>',
    '<div role="alert" aria-label="bot verification challenge">Please verify</div>']) {
    await page.setContent(checkout()+panel);
    const guarded=await probe('checkout',proof,true);
    assert.equal(guarded.state,'review');
    assert.match(guarded.reason,/Complete Quick verification/);
    assert.equal(clicks.order,0);
  }
  const baseOrder={...TARGET_ORDER,tcin:'94961316',name:'PlayStation 5 Console - Digital Edition'};
  const baseProof={tcin:baseOrder.tcin,images:[images.base]};
  await page.setContent(checkout({model:'base'}));
  const baseTrial=async(stage,commit)=>(await inject({target:{tabId},func:checkoutPage,args:[stage,baseOrder,baseProof,commit]}))[0].result;
  assert.equal((await baseTrial('checkout',false)).state,'ready');
  assert.equal((await baseTrial('checkout',true)).state,'review');
  await page.setContent(checkout({model:'base'})+cvvDrawer());
  assert.equal((await baseTrial('fill-cvv',true)).state,'review');
  assert.equal((await baseTrial('confirm-cvv',true)).state,'review');
  assert.equal(await page.getByPlaceholder('Enter CVV').inputValue(),'');
  assert.deepEqual(clicks,{add:0,order:0,confirm:0});
  const authorizedBase={...baseProof,totalCents:64949,cardTag:'mastercard:0000'};
  const oneBase=async(stage,commit=false,code=null)=>(await inject({target:{tabId},func:checkoutPage,args:[stage,baseOrder,authorizedBase,commit,code]}))[0].result;
  await page.setContent(checkout({model:'base',total:'$649.50'}));
  assert.equal((await oneBase('base-try-place',true)).state,'review');
  await page.setContent(checkout({model:'base',total:'$649.49'}));
  await page.evaluate(html=>{window.baseOrderClicks=0;document.getElementById('place').onclick=()=>{window.baseOrderClicks++;document.body.insertAdjacentHTML('beforeend',html);};},cvvDrawer());
  assert.equal((await oneBase('base-try-place',true)).state,'clicked');
  assert.equal((await oneBase('receipt')).state,'needs-code');
  assert.deepEqual(await oneBase('base-fill-stop',true,'314'),{state:'filled',masked:true});
  assert.equal((await oneBase('confirm-cvv',true)).state,'review');
  assert.equal(await page.evaluate(()=>window.baseOrderClicks),1);
  assert.equal(clicks.confirm,0);
  console.log('One-time base test: verified total, one Place click, masked code filled, zero Confirm clicks.');
  for(const [options,expected] of [
    [{},'ready'],[{total:'$1,100.00'},'ready'],[{total:'$1,100.01'},'review'],
    [{total:'$1,100.001'},'wait'],[{count:2},'review'],[{model:'base'},'review'],
    [{card:false},'wait'],[{zip:'11111'},'review'],[{method:'Ready for pickup in two hours'},'wait'],[{button:false},'wait'],
  ]) {
    await page.setContent(checkout(options));
    const res=await probe('checkout',proof,expected!=='ready');
    assert.equal(res.state,expected,JSON.stringify(options)+' '+res.reason);
  }
  await page.setContent(checkout({total:'$1,080.00'}));
  assert.equal((await probe('checkout',{...proof,totalCents:97424},true)).state,'review');
  const boundProof={...proof,totalCents:97424,cardTag:'mastercard:0000'};
  await page.setContent(checkout().replace('Mastercard *0000','Visa *0000'));
  assert.equal((await probe('checkout',boundProof,true)).state,'review','A different brand with the same suffix cannot receive the order');
  await page.setContent(checkout()+cvvDrawer());
  const filled=await inject({target:{tabId},func:checkoutPage,args:['fill-cvv',TARGET_ORDER,boundProof,true,'031']});
  assert.equal(filled[0].result.state,'filled');
  await page.locator('[role="dialog"] p').evaluate(el=>{el.textContent='Visa *0000';});
  assert.equal((await probe('confirm-cvv',boundProof,true)).state,'review','Recheck the drawer card immediately before Confirm');
  assert.equal(clicks.confirm,0);
  for (const [opts,ending,expected] of [[{},'0000','needs-code'],[{},'1111','review'],[{model:'base'},'0000','review'],[{total:'$1,100.01'},'0000','review']]) {
    await page.setContent(checkout(opts)+cvvDrawer(ending));
    assert.equal((await probe('receipt',boundProof)).state,expected);
    assert.equal(await page.getByPlaceholder('Enter CVV').inputValue(),'');
  }
  await page.setContent(checkout().replace('Pro Console quantity 1','Console - Digital Edition quantity 1'));
  assert.equal((await probe('checkout',proof,true)).state,'review','A conflicting thumbnail name blocks submission');
  assert.equal(clicks.order,0);
  console.log('Passed cart/checkout guards including base in cart with Pro saved, quantity, shipping, extras, saved payment, thumbnail identity and the $1,100.00 boundary.');

  const event=()=>({addListener(fn){this.handler=fn;}});
  const session={},local={};
  function storage(data) {
    return {get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),
      set:async patch=>Object.assign(data,structuredClone(patch)),
      remove:async keys=>{for(const key of [].concat(keys))delete data[key];}};
  }
  const messages=event(),alarm=event(),updated=event();
  let isReady=true, mutateBeforeSubmission=false, cartReadBarrier=null;
  globalThis.chrome={
    runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:messages},
    storage:{session:storage(session),local:storage(local)},action:{setBadgeText:async()=>{}},
    notifications:{create:async()=>{}},alarms:{create:async()=>{},clear:async()=>{},onAlarm:alarm},
    tabs:{get:async()=>({id:tabId,url:page.url(),status:isReady?'complete':'loading',autoDiscardable:true}),
      update:async(_,options)=>{if(options.url)await page.goto(options.url);},onUpdated:updated,onRemoved:event()},
    scripting:{executeScript:async request=>{
      if(request.func===checkoutPage && request.args[0]==='checkout' && request.args[3]) {
        assert.equal(local.orderAttempt?.tcin,TARGET_ORDER.tcin,'An order lock must exist before clicking');
        if(mutateBeforeSubmission) await page.setContent(checkout({model:'base'}));
      }
      const frames=await inject(request);
      if(cartReadBarrier && request.func===checkoutPage && request.args[0]==='cart' && !request.args[3] && frames[0].result.state==='ready') {
        const barrier=cartReadBarrier;
        cartReadBarrier=null;
        barrier.reached.resolve();
        await barrier.release.promise;
      }
      return frames;
    }},
  };
  page.on('domcontentloaded',()=>{isReady=true; if(updated.handler)updated.handler(tabId,{status:'complete'});});
  await import('../extension/target-shipping/worker.js');
  const send=msg=>new Promise(resolve=>messages.handler(msg,{id:'test',url:'chrome-extension://test/popup.html'},resolve));
  const arm=()=>send({kind:'arm',tabId,autoBuy:true,reload:false});
  async function waitForStop() {
    for(let i=0;i<200;i++) {
      if(!session.watch) return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Watch did not finish: '+JSON.stringify(session.reading));
  }
  await page.goto(proUrl);
  await arm(); await waitForStop();
  assert.equal(session.reading.state,'confirmed',JSON.stringify(session.reading));
  assert.deepEqual(clicks,{add:1,order:1,confirm:0});
  assert.equal(local.orderAttempt.totalCents,97424);
  alarm.handler({name:'check-shipping'});
  await page.goto(proUrl);
  assert.match((await arm()).error,/already attempted/);
  assert.match((await send({kind:'reset-cart'})).error,/order attempt/i);
  assert.match((await send({kind:'reset-watch'})).error,/order attempt/i);
  assert.deepEqual(clicks,{add:1,order:1,confirm:0});
  // Use independent fixture storage for another shopper session.
  for (const key of Object.keys(local)) delete local[key];
  mutateBeforeSubmission=true;
  await arm(); await waitForStop();
  assert.equal(session.reading.state,'review');
  assert.equal(clicks.order,1,'A changed final item must never receive the order click');
  assert.match(session.reading.reason,/differs/);
  console.log('Passed worker flow: Add → drawer → cart → checkout → one order click → confirmed receipt. Duplicate events, rearming and an item swap before submission caused zero additional order clicks.');
  for (const key of Object.keys(local)) delete local[key];
  mutateBeforeSubmission=false; requireCode=true;
  await page.goto(proUrl);
  for(const code of ['12','12x','12345',123]) {
    assert.match((await send({kind:'arm',tabId,autoBuy:true,payment:{code}})).error,/security code/i);
    assert.ok(!session.watch && !session.pendingCard);
  }
  assert.match((await send({kind:'arm',tabId,autoCart:true,payment:{code:'031'}})).error,/purchase mode/i);

  // Load the real popup and the base test form from disk. Only Chrome's API
  // boundary is emulated. The popup sends its actual arming message to the worker.
  const ui=await ctx.newPage();
  const uiOrigin='https://extension.test';
  let popupTabUrl=proUrl, openedUrl=null;
  const resources=new Set(['popup.html','popup.js','base-cvv-test.js','checkout.js']);
  await ui.route(uiOrigin+'/**',async route=>{
    const file=new URL(route.request().url()).pathname.slice(1);
    if(file==='base.html') return route.fulfill({contentType:'text/html',body:'<h1></h1><p id="status"></p>'});
    if(!resources.has(file)) return route.abort();
    const body=await readFile(new URL('../extension/target-shipping/'+file,import.meta.url));
    return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':'text/html',body});
  });
  await ui.exposeFunction('sendFixtureMessage',send);
  await ui.exposeFunction('fixtureActiveTab',()=>({id:tabId,url:popupTabUrl}));
  await ui.exposeFunction('fixtureOpenTab',({url})=>{openedUrl=url;});
  await ui.exposeFunction('fixtureGet',(area,keys)=>storage(area==='local'?local:session).get(keys));
  await ui.exposeFunction('fixtureSet',patch=>storage(local).set(patch));
  await ui.exposeFunction('fixtureInject',request=>inject({...request,func:checkoutPage}));
  await ui.addInitScript(()=>{
    window.chrome={
      tabs:{query:async()=>[await window.fixtureActiveTab()],create:window.fixtureOpenTab,update:async()=>{}},
      runtime:{sendMessage:window.sendFixtureMessage},alarms:{get:async()=>({periodInMinutes:3/60})},
      storage:{local:{get:keys=>window.fixtureGet('local',keys),set:window.fixtureSet},
        session:{get:keys=>window.fixtureGet('session',keys)},onChanged:{addListener(){}}},
      scripting:{executeScript:({target,args})=>window.fixtureInject({target,args})},
    };
  });
  await page.locator('#SHIPPING').evaluate(el=>{el.innerText='Shipping Not available';});
  await ui.goto(uiOrigin+'/popup.html');
  assert.equal(await ui.locator('#ending').count(),0);
  const codeField=ui.getByLabel('Security code',{exact:true});
  await codeField.fill('1x');
  await ui.getByRole('button',{name:/Arm one Pro/}).click();
  await ui.getByText(/Enter a 3- or 4-digit/).waitFor();
  assert.ok(!session.watch && !session.pendingCard);
  await codeField.fill('0123');
  await ui.getByRole('button',{name:/Arm one Pro/}).click();
  await ui.getByText(/One-use card code ready/).waitFor();
  assert.deepEqual(session.pendingCard,{key:session.watch.key,code:'0123'});
  assert.equal(await codeField.inputValue(),'');
  await ui.getByRole('button',{name:'Stop watching'}).click();
  await ui.getByRole('button',{name:/Arm one Pro/}).waitFor();
  assert.ok(!session.pendingCard && !session.watch);
  await codeField.fill('031');
  await ui.getByRole('button',{name:/Arm one Pro/}).click();
  await ui.getByText(/One-use card code ready/).waitFor();
  assert.deepEqual(session.pendingCard,{key:session.watch.key,code:'031'});
  await page.locator('#SHIPPING').evaluate(el=>{el.innerText='Shipping Get it tomorrow';});
  alarm.handler({name:'check-shipping'});
  await waitForStop();
  assert.equal(session.reading.state,'confirmed',JSON.stringify(session.reading));
  assert.deepEqual(clicks,{add:3,order:2,confirm:1});
  assert.ok(local.orderAttempt.codeAttemptAt);
  assert.ok(!session.pendingCard);
  assert.doesNotMatch(JSON.stringify(local), /"code"|"ending"|"cardTag"/);
  await page.goto(proUrl);
  assert.match((await arm()).error,/already attempted/);
  for(const scenario of ['changed drawer card','no code supplied']){
    for(const key of Object.keys(local)) delete local[key];
    drawerEnding=scenario==='changed drawer card'?'1111':'0000';
    const confirmations=clicks.confirm;
    await page.goto(proUrl);
    if(scenario==='changed drawer card') await send({kind:'arm',tabId,autoBuy:true,payment:{code:'031'}});
    else await arm();
    await waitForStop();
    assert.equal(session.reading.state,'review',scenario);
    assert.equal(await page.getByPlaceholder('Enter CVV').inputValue(),'',scenario);
    assert.equal(clicks.confirm,confirmations);
    assert.ok(!session.pendingCard && !local.orderAttempt.codeAttemptAt);
    assert.ok(local.orderAttempt,'The order lock survives a payment review stop');
  }
  console.log('Passed real popup with CVV only, invalid input, Stop cleanup, changed card and absent code. The matching drawer confirmed once.');

  // The separately authorized base form must still fill and stop. Do not inherit
  // any policy or secret from the Pro watch for this independent test fixture.
  drawerEnding='0000';
  checkoutOptions={model:'base',total:'$649.49'};
  await page.goto(origin+'/co-review');
  await ui.goto(uiOrigin+'/base.html');
  await ui.evaluate(async({tabId,documentId})=>{
    const {prepareBaseCvvTest}=await import('./base-cvv-test.js');
    await prepareBaseCvvTest({tabId,documentId},document.querySelector('#status'),()=>{});
  },{tabId,documentId:String(docId)});
  assert.equal(await ui.locator('input').count(),1);
  await ui.getByLabel('One-time security code').fill('031');
  const beforeBase={...clicks};
  await ui.getByRole('button',{name:/Click Place your order once/}).click();
  await ui.getByText('Stopped with the CVV drawer open on Target.').waitFor();
  assert.equal(await page.getByPlaceholder('Enter CVV').inputValue(),'031');
  assert.equal(clicks.order,beforeBase.order+1);
  assert.equal(clicks.confirm,beforeBase.confirm);
  assert.equal(local.baseCvvTestAttempt.outcome,'filled-stopped');
  assert.doesNotMatch(JSON.stringify(local), /"code"|"ending"|"cardTag"/);
  console.log('Passed actual base CVV form with one input and zero base Confirm clicks.');

  // Start with an independently empty profile for the reset/rearm scenarios.
  for(const key of Object.keys(local)) delete local[key];
  session.reading={state:'attention',reason:'The watched tab left the PS5 Pro listing.',at:new Date().toISOString()};
  local.previousCartAttempt={tcin:TARGET_ORDER.tcin,at:session.reading.at};
  popupTabUrl=origin+'/cart';
  await ui.goto(uiOrigin+'/popup.html');
  await ui.getByRole('button',{name:'Open PS5 Pro listing'}).click();
  assert.equal(openedUrl,proUrl);
  assert.equal(await ui.getByRole('button',{name:/Arm one Pro/}).isEnabled(),false);
  popupTabUrl=proUrl;
  await ui.reload();
  await ui.getByText('Ready to arm this PS5 Pro tab.').waitFor();
  const historicalAdd={...local.previousCartAttempt};
  await ui.getByRole('button',{name:'Reset watch',exact:true}).click();
  await ui.waitForFunction(()=>document.querySelector('#reset').disabled && !document.querySelector('#toggle').disabled);
  assert.ok(!session.reading && !session.watch);
  assert.deepEqual(local.previousCartAttempt,historicalAdd);
  assert.equal(await ui.getByRole('button',{name:/Arm one Pro/}).isEnabled(),true);

  local.cartAttempt={tcin:TARGET_ORDER.tcin,at:new Date().toISOString(),watchKey:'missed'};
  await ui.reload();
  await ui.getByText('An Add attempt is recorded. Check the active cart before resetting.').waitFor();
  assert.equal(await ui.getByRole('button',{name:/Arm one Pro/}).isEnabled(),false);
  await ui.getByRole('button',{name:'Reset Add attempt'}).click();
  await ui.getByText('Ready to arm this PS5 Pro tab.').waitFor();
  assert.equal(local.cartAttempt,undefined);

  checkoutOptions={};requireCode=false;
  await page.goto(proUrl);
  const barrier={reached:Promise.withResolvers(),release:Promise.withResolvers()};
  cartReadBarrier=barrier;
  const ordersBeforeReset=clicks.order;
  const starting=send({kind:'arm',tabId,autoBuy:true,payment:{code:'031'}});
  // Race reset against a completed cart read before the worker can click Checkout.
  const timer=setTimeout(()=>barrier.reached.reject(Error('Cart check did not start')),10000);
  try {
    await barrier.reached.promise;
    const pendingReset=send({kind:'reset-watch'});
    const addAt=local.cartAttempt.at;
    barrier.release.resolve();
    assert.ok(!(await pendingReset).error);
    await starting;
    assert.equal(local.previousCartAttempt.at,addAt);
  } finally {clearTimeout(timer);barrier.release.resolve();}
  await send({kind:'status'});
  assert.ok(!session.watch && !session.pendingCard && !session.reading && !local.cartAttempt && !local.orderAttempt);
  assert.equal(clicks.order,ordersBeforeReset);

  local.orderAttempt={tcin:TARGET_ORDER.tcin,totalCents:97424,at:new Date().toISOString()};
  const sealed={...local.orderAttempt};
  await ui.reload();
  await ui.getByText('An order attempt is recorded. Check Target order history.').waitFor();
  assert.equal(await ui.getByRole('button',{name:'Reset watch',exact:true}).isEnabled(),false);
  assert.match((await send({kind:'reset-watch'})).error,/reset is locked/i);
  assert.deepEqual(local.orderAttempt,sealed);
  console.log('Passed wrong-tab guidance, stale status, missed Add reset, active cart/reset race, preserved timestamps and locked order recovery.');
  if(signedIn){
    for(const path of [new URL(proUrl).pathname,'/cart','/co-review','/co-confirmation']) assert.ok(authenticatedPaths.has(path),path);
    console.log('Passed persistent session handoff: visible fixture login, headless restart, two authenticated stock reads, cart, checkout and receipt.');
  }
} finally {
  if(signedIn) await signedIn.close();
  else await browser.close();
}
