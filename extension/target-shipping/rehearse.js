import {checkoutPage, TARGET_ORDER} from './checkout.js';
import {cartAcknowledgement, observeShipping} from './shipping.js';

const base={...TARGET_ORDER, tcin:'94961316', name:'PlayStation 5 Console - Digital Edition'};
const status=document.querySelector('#status');
const steps=document.querySelector('#steps');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function passed(message) {
  const li=document.createElement('li');
  li.textContent=message;
  steps.append(li);
}

// These are the only extra live actions the rehearsal can take. Neither the
// order button nor the CVV Confirm button is ever an action in this function.
function paymentPage(action) {
  if(location.origin!=='https://www.target.com') return {state:'review',reason:'The tab left Target.'};
  const visible=el=>el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) && el.getClientRects().length>0;
  const nodes=selector=>[...document.querySelectorAll(selector)].filter(visible);
  const name=el=>(el.getAttribute('aria-label')||el.innerText||'').trim();
  const buttons=nodes('button');
  if(nodes('h1,h2,h3,h4,[role="heading"],[role="dialog"][aria-label]').some(h=>/^confirm cvv$/i.test(name(h))))
    return {state:'cvv'};
  if(action==='detect') return {state:'absent'};
  const baseImage=nodes('img,[role="img"]').some(el=>/^PlayStation 5 Console - Digital Edition quantity 1$/i.test(el.getAttribute('aria-label')||el.alt||''));
  if(!baseImage) return {state:'wait',reason:'Waiting for the base item on checkout.'};
  if(action==='edit-address' && location.pathname==='/checkout') {
    const links=nodes('a[href]').filter(a=>a.origin===location.origin && a.pathname==='/checkout/shipping' && /^edit(?: address)?$/i.test(name(a)));
    if(links.length!==1) return {state:'wait',reason:'Waiting for Edit Address.'};
    // This value stays inside the original checkout document and is never
    // returned, logged, or saved. Only reselect the very same address.
    delete globalThis.__baseRehearsalStreet;
    for(let el=links[0].parentElement;el && el!==document.body;el=el.parentElement) {
      if(!/\b75013\b/.test(el.innerText)||el.innerText.length>600)continue;
      const street=el.innerText.split(/\n+/).map(s=>s.trim()).find(s=>/^\d{1,8}\s+[a-z]/i.test(s));
      if(street)globalThis.__baseRehearsalStreet=street.toLowerCase();
      break;
    }
    links[0].click();return {state:'clicked'};
  }
  if(action==='address' || action==='save-address') {
    if(location.pathname!=='/checkout/shipping') return {state:'wait',reason:'Waiting for the address step.'};
    const disabledOrder=buttons.some(b=>/^place your order$/i.test(name(b)) && (b.disabled||b.getAttribute('aria-disabled')==='true'));
    const saved=nodes('input[type="radio"]:checked,[role="radio"][aria-checked="true"]').filter(el=>{
      const label=[name(el),...(el.labels?[...el.labels].map(name):[]),
        ...(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.innerText)].join(' ').toLowerCase();
      return globalThis.__baseRehearsalStreet && label.includes(globalThis.__baseRehearsalStreet) && /\b75013\b/.test(label);
    });
    const save=buttons.filter(b=>/^(?:save and continue|use this address|ship to this address)$/i.test(name(b)));
    if (!disabledOrder) return {state:'wait',reason:'Waiting for the address editor to finish opening.'};
    if (saved.length!==1 || save.length!==1 || save[0].disabled)
      return {state:'skip',reason:'No unambiguous control to reselect the current saved address.'};
    if(action==='save-address') {delete globalThis.__baseRehearsalStreet;save[0].click();return {state:'clicked'};}
    return {state:'ready'};
  }
  if(action==='edit' && location.pathname==='/checkout') {
    const links=nodes('a[href]').filter(a=>a.origin===location.origin && a.pathname==='/checkout/payment' && /^edit(?: payment)?$/i.test(name(a)));
    if(links.length!==1) return {state:'wait',reason:'Waiting for Edit Payment.'};
    links[0].click();return {state:'clicked'};
  }
  if(location.pathname!=='/checkout/payment') return {state:'wait',reason:'Waiting for the saved-payment route.'};
  // Restrict the test to saving the already selected card. Require the separate
  // order action to be explicitly disabled on this edit step.
  const selected=nodes('input[type="radio"]:checked,[role="radio"][aria-checked="true"]').filter(el=>
    /Mastercard.*(?:ending|\*)/i.test([name(el),...(el.labels?[...el.labels].map(name):[]),
      ...(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.innerText)].join(' ')));
  const place=buttons.filter(b=>/^place your order$/i.test(name(b)));
  const save=buttons.filter(b=>/^save and continue$/i.test(name(b)));
  if(selected.length!==1 || place.length!==1 || (!place[0].disabled && place[0].getAttribute('aria-disabled')!=='true') || save.length!==1)
    return {state:'wait',reason:'Cannot verify the selected card and disabled order button on Edit Payment.'};
  if(action==='save' && !save[0].disabled && save[0].getAttribute('aria-disabled')!=='true') {
    save[0].click();return {state:'clicked'};
  }
  return {state:'ready'};
}

function putBaseBack(commit=false) {
  if(location.origin!=='https://www.target.com' || location.pathname!=='/cart') return {state:'wait'};
  const controls=[...document.querySelectorAll('button')].filter(b=>b.checkVisibility() &&
    /^Save for later PlayStation 5 Console - Digital Edition$/i.test(b.getAttribute('aria-label')||b.innerText));
  if(controls.length!==1) return {state:'wait',reason:'Waiting for the base item in the active cart.'};
  for(let row=controls[0].parentElement;row && row!==document.body;row=row.parentElement) {
    const items=[...row.querySelectorAll('a[href*="/A-"]')];
    if (!items.length) continue;
    if(items.some(a=>a.origin!==location.origin||!a.pathname.endsWith('/A-94961316')))
      return {state:'review',reason:'Cannot isolate the rehearsal item for cleanup.'};
    if(commit) controls[0].click();
    return {state:commit?'clicked':'ready'};
  }
  return {state:'wait',reason:'Waiting for the exact base item link.'};
}

async function run(tabId) {
  const call=async(func,args=[],doc=null)=>{
    const target=doc?{tabId,documentIds:[doc]}:{tabId,frameIds:[0]};
    const [r]=await chrome.scripting.executeScript({target,func,args});
    if (!r?.result) throw Error('The tab or document is unavailable.');
    return r;
  };
  async function until(read,states) {
    let reason='Waiting for Target to render the next step.';
    const end=Date.now()+15000;
    do {
      let frame;
      try {frame=await read();}catch{await pause(200);continue;}
      if(states.includes(frame.result.state)) return frame;
      if(['review','attention','away','unavailable'].includes(frame.result.state)) throw Error(frame.result.reason||'Target requires review.');
      reason=frame.result.reason||reason;
      await pause(200);
    }while(Date.now()<end);
    throw Error(reason);
  }
  const fs=(step,proof,commit=false,doc=null)=>call(checkoutPage,[step,base,proof,commit],doc);
  let owned=false, drawerOpen=false;
  try {
    status.textContent='Checking the base Digital Edition and its shipping offer.';
    const product=await until(()=>call(observeShipping,[null,'base-rehearsal','observe']),['available']);
    let staged=await call(observeShipping,[null,'base-rehearsal','prepare-cart'],product.documentId);
    if(staged.result.state==='selecting') staged=await until(()=>call(observeShipping,[null,'base-rehearsal','inspect-cart'],product.documentId),['ready']);
    if(staged.result.state!=='ready' || staged.result.before!==0) throw Error(staged.result.reason||'An empty cart is required.');
    const added=await call(observeShipping,[null,'base-rehearsal','add-one'],product.documentId);
    if(added.result.state!=='clicked') throw Error(added.result.reason);
    owned=true;
    const ackDeadline=Date.now()+7000;
    let ack=false;
    do {
      const [frame]=await chrome.scripting.executeScript({target:{tabId,documentIds:[product.documentId]},func:cartAcknowledgement,args:[0,'base-rehearsal']});
      ack=!!frame?.result;
      if(!ack) await pause(150);
    }while(!ack && Date.now()<ackDeadline);
    if(!ack) throw Error('Target did not acknowledge Add.');
    passed('Target acknowledged adding one base PS5 for shipping.');
    const drawer=await fs('drawer',null,true,product.documentId);
    if(drawer.result.state==='use-cart-url') await chrome.tabs.update(tabId,{url:'https://www.target.com/cart'});
    else if(drawer.result.state!=='clicked') throw Error('The cart drawer could not be opened.');
    status.textContent='Checking the active cart line.';
    const cart=await until(async()=>{
      const tab=await chrome.tabs.get(tabId);
      if(!tab.url || new URL(tab.url).pathname!=='/cart' || tab.status==='loading') return {result:{state:'wait'}};
      return fs('cart',{primaryImage:added.result.primaryImage});
    },['ready']);
    passed('The cart guard verified the active item, quantity and shipping.');
    const checked=await fs('cart',cart.result.proof,true,cart.documentId);
    if(checked.result.state!=='clicked') throw Error(checked.result.reason||'The cart changed.');
    const readReview=async()=>{
      const tab=await chrome.tabs.get(tabId);
      if(!tab.url?.startsWith('https://www.target.com/checkout') && !tab.url?.startsWith('https://www.target.com/co-'))
        return {result:{state:'wait',reason:'Waiting for checkout navigation.'}};
      return fs('checkout',cart.result.proof);
    };
    status.textContent='Validating the actual order review without submitting.';
    const review=await until(readReview,['ready']);
    passed('The checkout guard verified the base console, address, saved card and $'+(review.result.totalCents/100).toFixed(2)+' final total.');
    const proCheck=await call(checkoutPage,['checkout',TARGET_ORDER,{tcin:TARGET_ORDER.tcin,images:[]},false],review.documentId);
    if(proCheck.result.state==='ready') throw Error('The Pro guard unexpectedly accepted the base order.');
    passed('The armed Pro policy rejected this base order.');
    const edit=await call(paymentPage,['edit'],review.documentId);
    if(edit.result.state==='cvv') drawerOpen=true;
    else {
      if(edit.result.state!=='clicked') throw Error(edit.result.reason);
      const saved=await until(()=>call(paymentPage,['inspect']),['cvv','ready']);
      drawerOpen=saved.result.state==='cvv';
      if(!drawerOpen) {
        passed('Edit Payment showed the selected saved card while Place your order was disabled.');
        const move=await call(paymentPage,['save'],saved.documentId);
        if(move.result.state!=='clicked') throw Error(move.result.reason);
        const next=await until(async()=>{
          const prompt=await call(paymentPage,['detect']);
          if(prompt.result.state==='cvv') return prompt;
          const tab=await chrome.tabs.get(tabId);
          if(new URL(tab.url).pathname!=='/checkout') return {result:{state:'wait'}};
          return readReview();
        },['cvv','ready']);
        drawerOpen=next.result.state==='cvv';
      }
    }
    if(!drawerOpen) {
      passed('Saving the selected card returned to order review without a CVV prompt.');
      const current=await until(readReview,['ready']);
      const address=await call(paymentPage,['edit-address'],current.documentId);
      if(address.result.state==='clicked') {
        const option=await until(()=>call(paymentPage,['address']),['cvv','skip','ready']);
        drawerOpen=option.result.state==='cvv';
        if(option.result.state==='ready') {
          const same=await call(paymentPage,['save-address'],option.documentId);
          if(same.result.state==='clicked') {
            passed('Reselected the existing saved shipping address without editing it.');
            const result=await until(async()=>{
              const test=await call(paymentPage,['detect']);
              if(test.result.state==='cvv') return test;
              const tab=await chrome.tabs.get(tabId);
              return new URL(tab.url).pathname==='/checkout'?readReview():{result:{state:'wait'}};
            },['cvv','ready']);
            drawerOpen=result.result.state==='cvv';
          }
        } else if(option.result.state==='skip') passed(option.result.reason);
      }
    }
    passed(drawerOpen?'Target displayed the real Confirm CVV drawer before submission.':'No Confirm CVV drawer appeared on the pre-order routes tested.');
    status.textContent=drawerOpen?'The live drawer is open on the base tab. No confirmation was clicked.':'Stopped before Place your order. No base order was submitted.';
  } catch(error) {
    const prompt=await call(paymentPage,['detect']).catch(()=>null);
    drawerOpen=prompt?.result?.state==='cvv';
    status.textContent=drawerOpen?'The live Confirm CVV drawer is open. No confirmation was clicked.':'Stopped. '+error.message;
  }
  finally {
    if(owned && !drawerOpen) {
      try {
        const tab=await chrome.tabs.get(tabId);
        if(new URL(tab.url).origin!=='https://www.target.com') throw Error();
        if(new URL(tab.url).pathname!=='/cart') await chrome.tabs.update(tabId,{url:'https://www.target.com/cart'});
        const cleanup=await until(()=>call(putBaseBack),['ready']);
        if((await call(putBaseBack,[true],cleanup.documentId)).result.state!=='clicked') throw Error();
        await until(()=>call(()=>{
          const empty=[...document.querySelectorAll('a[href*="/cart"]')].some(a=>/\bcart\s*[:,]?\s*0\s+items?\b/i.test(a.getAttribute('aria-label')||a.innerText));
          return {state:empty?'ready':'wait'};
        }),['ready']);
        passed('Returned the base test item to Saved for later.');
      } catch {passed('Check the Target cart for the rehearsal item.');}
    }
    await chrome.storage.local.set({lastBaseRehearsal:{at:new Date().toISOString(),status:status.textContent,steps:[...steps.children].map(el=>el.textContent)}});
  }
}

const {baseRehearsalTicket}=await chrome.storage.session.get('baseRehearsalTicket');
if(!baseRehearsalTicket || baseRehearsalTicket.ticket!==location.hash.slice(1)) status.textContent='Start the rehearsal from the extension on the base product tab.';
else {
  await chrome.storage.session.remove('baseRehearsalTicket');
  if(baseRehearsalTicket.mode==='live-cvv'){
    const {prepareBaseCvvTest}=await import('./base-cvv-test.js');
    await prepareBaseCvvTest(baseRehearsalTicket,status,passed);
  }else{
    await navigator.locks.request('target-base-rehearsal',{ifAvailable:true},async lock=>{
      if(lock) await run(baseRehearsalTicket.tabId);
      else status.textContent='A rehearsal is already running.';
    });
  }
}
