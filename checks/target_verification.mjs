import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {advanceVerification} from '../extension/target-shipping/verification.js';
import {observeShipping} from '../extension/target-shipping/shipping.js';
import {checkoutPage,TARGET_ORDER} from '../extension/target-shipping/checkout.js';

// No retailer requests or account profile. This harness supplies chrome.dom's
// root access explicitly; it does not claim a live CAPTCHA accepts synthetic input.
const url='https://www.target.com/p/playstation-5-pro-console/-/A-93620188';
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try {
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',r=>r.request().url()===url?r.fulfill({body:'<h1>Fixture</h1>',contentType:'text/html'}):r.abort());
  const page=await context.newPage();
  await page.goto(url);
  const fixture=async(options={})=>{
    await page.setContent('<h1>PlayStation 5 Pro Console</h1><section aria-label="Fulfillment"><button id="SHIPPING" aria-label="Shipping, selected">Shipping Not available</button></section><button id="add">Add to cart</button>');
    await page.evaluate(options=>{
      window.fixtureClicks=[];
      window.fixtureEvents=[];
      window.chrome={runtime:{sendMessage:async()=>({})}};
      const roots=new WeakMap();
      if (!options.noApi) chrome.dom={openOrClosedShadowRoot:host=>roots.get(host)||null};
      const modal=document.createElement('iframe');modal.id='px-captcha-modal';
      modal.style='position:fixed;inset:0;width:100%;height:100%;background:white;z-index:9999';
      document.body.append(modal);
      const outer=modal.contentDocument;
      outer.open();outer.write('<title>Human verification</title><div class="px-captcha-header">Quick verification</div><div id="px-captcha"></div>');outer.close();
      const host=outer.querySelector('#px-captcha'), root=host.attachShadow({mode:'closed'});roots.set(host,root);
      const makeFrame=(hidden=false)=>{
        const frame=outer.createElement('iframe');frame.title='Human verification challenge';
        frame.style=hidden?'display:none':'display:block;width:400px;height:100px';root.append(frame);
        const doc=frame.contentDocument;
        doc.open();doc.write('<title>Human verification challenge</title><a role="button" tabindex="0" aria-label="Accessible challenge">Icon</a><div role="button" tabindex="0" aria-label="Press &amp; Hold Human Challenge">Press &amp; hold</div>');doc.close();
        const first=doc.querySelector('a'), second=doc.querySelector('div');
        // Match the observed live events. Deliberately no click listener.
        const activate=event=>{
          window.fixtureEvents.push({target:hidden?'hidden':'accessible',type:event.type,button:event.button,pointerType:event.pointerType});
          window.fixtureClicks.push({button:hidden?'hidden-accessible':'accessible',at:performance.now()});
          if(options.ignoreInput || (options.trustedOnly && !event.isTrusted))return;
          first.setAttribute('aria-disabled','true');
          if (!options.noAgain) {second.setAttribute('aria-label','Press again');second.textContent='Press again';}
        };
        first.addEventListener('pointerup',activate);
        first.addEventListener('mouseup',activate);
        let pressed=false;
        second.addEventListener('pointerdown',event=>{
          window.fixtureEvents.push({target:'again',type:event.type,button:event.button,buttons:event.buttons,pointerType:event.pointerType});
          pressed=second.getAttribute('aria-label')==='Press again' && event.button===0 && event.buttons===1;
          if(options.replaceOnDown) second.replaceWith(second.cloneNode(true));
        });
        second.addEventListener('pointerup',event=>{
          window.fixtureEvents.push({target:'again',type:event.type,button:event.button,buttons:event.buttons,pointerType:event.pointerType});
          if (!pressed) return;
          window.fixtureClicks.push({button:hidden?'hidden-again':'again',at:performance.now()});
          if (!options.keepOverlay) modal.remove();
        });
        return {frame,doc,first,second};
      };
      makeFrame(true);makeFrame(true);
      const live=makeFrame();
      if (options.duplicateFrame) makeFrame();
      if (options.duplicateFirst) live.first.after(live.first.cloneNode(true));
      if (options.disabledFirst) live.first.setAttribute('aria-disabled','true');
      if (options.prestarted) {live.second.setAttribute('aria-label','Press again');live.second.textContent='Press again';}
      if (options.hiddenModal) modal.hidden=true;
      if (options.inert) live.doc.body.inert=true;
      if (options.pointerNone) live.first.style.pointerEvents='none';
      // References belong only to this fixture, never the production helper.
      window.fixture={modal,outer,root,...live};
    },options);
  };
  const probe=key=>page.evaluate(advanceVerification,key);
  const clicks=()=>page.evaluate(()=>window.fixtureClicks);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const expire=()=>page.evaluate(()=>{
    const r=window.__ps5TargetVerification.get(fixture.modal);r.started=performance.now()-45001;
  });

  await fixture({keepOverlay:true});
  await page.evaluate(()=>{fixture.first.click();fixture.second.click();});
  assert.equal((await clicks()).length,0,'The old .click() implementation cannot activate these live-style handlers');
  assert.equal((await page.evaluate(observeShipping,null)).state,'verification');
  assert.equal((await page.evaluate(({fn,order})=>Function('return ('+fn+')')()('checkout',order,null,true),
    {fn:checkoutPage.toString(),order:TARGET_ORDER})).state,'review');
  assert.equal((await probe('one')).state,'verification');
  assert.equal((await probe('one')).state,'verification');
  assert.deepEqual((await clicks()).map(c=>c.button),['accessible']);
  await sleep(3050);
  await probe('one');await probe('one');
  const sequence=await clicks();
  assert.deepEqual(sequence.map(c=>c.button),['accessible','again']);
  assert.ok(sequence[1].at-sequence[0].at>=3000);
  assert.deepEqual(await page.evaluate(()=>fixtureEvents.map(e=>[e.target,e.type,e.pointerType])),
    [['accessible','pointerup','mouse'],['again','pointerdown','mouse'],['again','pointerup','mouse']]);
  await expire();assert.equal((await probe('one')).state,'attention');
  assert.equal((await clicks()).length,2,'Timeout never repeats either click');
  console.log('Passed closed-shadow fixture, hidden decoys, exact controls, three-second minimum and no repeated clicks.');

  for (const options of [{noApi:true},{duplicateFrame:true},{duplicateFirst:true},{disabledFirst:true},
    {prestarted:true},{hiddenModal:true},{inert:true},{pointerNone:true}]) {
    await fixture(options);await probe('guard');
    assert.equal((await clicks()).length,0,JSON.stringify(options));
  }
  await fixture({noAgain:true});await probe('missing');await expire();
  assert.equal((await probe('missing')).state,'attention');assert.equal((await clicks()).length,1);
  await fixture();await page.evaluate(()=>{fixture.outer.title='';});
  assert.equal((await probe('loading')).state,'verification');assert.equal((await clicks()).length,0);
  await page.evaluate(()=>{fixture.outer.title='Human verification';});
  assert.equal((await probe('loading')).state,'verification');assert.equal((await clicks()).length,1);
  await fixture();await probe('second-guard');
  await page.evaluate(()=>fixture.second.setAttribute('aria-disabled','true'));
  await sleep(3050);await probe('second-guard');
  assert.equal((await clicks()).length,1,'Disabled second control is never clicked');
  await page.evaluate(()=>{fixture.second.removeAttribute('aria-disabled');fixture.second.after(fixture.second.cloneNode(true));});
  assert.equal((await probe('second-guard')).state,'attention','Ambiguous second control ends the attempt');
  assert.equal((await clicks()).length,1);
  await fixture();
  await page.evaluate(()=>{fixture.first.dispatchEvent=()=>{throw Error('Uncertain input transport');};});
  assert.equal((await probe('uncertain')).state,'attention');
  await page.evaluate(()=>{delete fixture.first.dispatchEvent;});
  assert.equal((await probe('uncertain')).state,'attention');
  assert.equal((await clicks()).length,0,'An uncertain first click is not replayed');
  await fixture();await probe('old');
  assert.equal((await probe('new')).state,'attention','Rearming cannot replay an existing overlay');
  await page.evaluate(()=>{fixture.frame.srcdoc='<title>Human verification challenge</title><div role="button" aria-label="Press again">Press again</div>';});
  await sleep(50);
  assert.equal((await probe('old')).state,'attention','Replaced frame document cannot inherit first-click proof');
  assert.equal((await clicks()).length,1);
  for (const options of [{ignoreInput:true},{trustedOnly:true}]) {
    await fixture(options);
    const sent=await probe('unacknowledged');assert.match(sent.reason,/Waiting for Target to respond/);
    await sleep(5050);
    const stopped=await probe('unacknowledged');
    assert.equal(stopped.state,'attention');assert.match(stopped.reason,/did not respond/);
    await probe('unacknowledged');assert.equal((await clicks()).length,1,'Rejected input never retries or advances');
  }
  await fixture({replaceOnDown:true});await probe('replacement');await sleep(3050);await probe('replacement');
  assert.deepEqual(await page.evaluate(()=>fixtureEvents.map(e=>e.type)),['pointerup','pointerdown'],
    'Do not release on a detached or replaced second control');
  console.log('Passed disabled/inert/ambiguous controls, missing API, missing second prompt, replacement document and rearm guards.');

  // Worker integration uses the same serialized executeScript boundary as the
  // other extension checks. No timers capable of clicking live in the page.
  const event=()=>({addListener(fn){this.fn=fn;}});
  const messages=event(),alarm=event(),updated=event(),removed=event();
  const session={},local={};let reloads=0;
  const storage=store=>({
    get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in store).map(k=>[k,structuredClone(store[k])])),
    set:async patch=>Object.assign(store,structuredClone(patch)),
    remove:async keys=>{for(const key of [].concat(keys))delete store[key];},
  });
  globalThis.chrome={
    runtime:{id:'verification-fixture',getURL:p=>'chrome-extension://verification-fixture/'+p,onMessage:messages},
    storage:{session:storage(session),local:storage(local)},
    action:{setBadgeText:async()=>{}},notifications:{create:async()=>{}},
    alarms:{onAlarm:alarm,create:async()=>{},clear:async()=>{}},
    tabs:{onUpdated:updated,onRemoved:removed,get:async()=>({url,status:'complete',autoDiscardable:true}),
      update:async()=>{},reload:async()=>{reloads++;}},
    scripting:{executeScript:async({func,args,target})=>{
      assert.equal(target.tabId,42);
      return [{documentId:'doc',result:await page.evaluate(({fn,args})=>Function('return ('+fn+')')()(...args),{fn:func.toString(),args})}];
    }},
  };
  await import('../extension/target-shipping/worker.js');
  const command=kind=>new Promise(resolve=>messages.fn({kind,tabId:42,reload:true},
    {id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')},resolve));
  const until=async predicate=>{for(let i=0;i<120;i++){if(await predicate())return;await sleep(50);}throw Error('Fixture timed out: '+JSON.stringify({reading:session.reading,clicks:await clicks()}));};
  await fixture();await command('arm');
  assert.equal(session.reading.state,'verification');
  alarm.fn({name:'check-shipping'});updated.fn(42,{status:'complete'});await command('status');
  assert.equal(reloads,0);assert.equal((await clicks()).length,1);
  await until(()=>session.reading?.state==='unavailable');
  assert.deepEqual((await clicks()).map(c=>c.button),['accessible','again']);
  assert.ok(session.watch,'Resume stock observation after overlay clears');
  assert.equal(reloads,0,'Verification and its immediate stock reread do not refresh');
  assert.ok(!local.cartAttempt&&!local.orderAttempt);
  await command('stop');

  for(const cancel of ['stop','reset-watch']) {
    await fixture();await command('arm');await command(cancel);await sleep(3100);
    alarm.fn({name:'check-shipping'});await command('status');
    assert.equal((await clicks()).length,1,cancel+' cancels second click');
    assert.equal(session.watch,undefined);
  }
  await fixture();local.cartAttempt={at:new Date().toISOString(),tcin:'93620188'};
  await command('arm');assert.equal(session.reading.state,'review');assert.equal((await clicks()).length,0);
  delete local.cartAttempt;

  // A Stop arriving while a read is outstanding must suppress the next action.
  await fixture();await command('arm');
  let release,entered;
  const blocked=new Promise(resolve=>{entered=resolve;});
  // Block a read, not a click already dispatched to Chrome.
  const execute=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async request=>{
    if(request.func.name==='observeShipping') {
      chrome.scripting.executeScript=execute;entered();await new Promise(r=>{release=r;});
    }
    return execute(request);
  };
  alarm.fn({name:'check-shipping'});await blocked;
  const stopping=command('stop');release();await stopping;
  await sleep(3100);assert.equal((await clicks()).length,1);
  console.log('Passed worker hold/resume, duplicate events, Stop/Reset cancellation, outstanding reads and shopping-attempt guards.');
} finally {await browser.close();}
