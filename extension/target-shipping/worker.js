// One MV3 worker coordinates tab events, alarms and popup commands. Session
// storage survives worker suspension. Local attempt records survive browser
// restarts and are written before their corresponding merchant actions.
import {observeShipping,stopObserver,cartAcknowledgement} from './shipping.js';
import {checkoutPage,isProListing,TARGET_ORDER} from './checkout.js';
import {advanceVerification} from './verification.js';

const SESSION=chrome.storage.session, ALARM='check-shipping', INTERVAL=3;
const popup=chrome.runtime.getURL('popup.html');
let pending=Promise.resolve();
let stopRequested=false, pollTimer=null;
// Hold pre-order work as soon as Reset arrives, even if a slow Add check has
// the queue. Once an order intent is durable, receipt handling owns the outcome.
let resetsPending=0;
const haltBeforeOrder=()=>stopRequested || resetsPending>0;
function serial(fn) {
  const task=pending.then(fn);
  pending=task.catch(()=>{});
  return task;
}
async function badge(text) {await chrome.action.setBadgeText({text});}
async function finish(watch,state,reason,at=new Date().toISOString()) {
  clearTimeout(pollTimer);
  pollTimer=null;
  await SESSION.remove('watch');
  await SESSION.remove('pendingCard');
  await chrome.alarms.clear(ALARM);
  await chrome.scripting.executeScript({target:{tabId:watch.tabId},func:stopObserver,args:[watch.key]}).catch(()=>{});
  if (watch.restoreDiscard) await chrome.tabs.update(watch.tabId,{autoDiscardable:true}).catch(()=>{});
  const result={state,reason,at};
  if (watch.autoBuy) await chrome.storage.local.set({lastPurchaseResult: result});
  await SESSION.set({reading:result});
  await badge(state==='confirmed'?'DONE':state==='available'?'SHIP':state==='added'?'CART':['attention','review'].includes(state)?'!':'');
  if (state==='available') {
    await chrome.storage.local.set({lastAvailableAt:at});
    await chrome.notifications.create('target-ps5-shipping',{type:'basic',iconUrl:'icon.png',title:'Target · PS5 Pro',message:'Shipping is available. Check your Target product tab.'});
  }
  if (state==='attention') {
    await chrome.notifications.create('target-ps5-attention',{type:'basic',iconUrl:'icon.png',title:'Target shipping watch paused',message:reason});
  }
  if (['added','review','confirmed'].includes(state)) {
    await chrome.notifications.create('target-ps5-cart',{type:'basic',iconUrl:'icon.png',title:watch.autoBuy?'Target · PS5 Pro order':'Target · PS5 Pro cart',message:reason});
  }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The alarm also wakes a suspended worker. Between checkout navigation events
// and verification state changes, poll only the existing local DOM.
function scheduleCheck() {
  if (pollTimer!==null || stopRequested) return;
  pollTimer=setTimeout(()=>{
    pollTimer=null;
    void serial(()=>check()).catch(()=>{});
  },180);
}
async function stageWatch(watch,phase,reason,proof) {
  // A tab update can arrive during a click. Resume from the recorded next stage
  // so a navigation or worker suspension cannot replay the preceding action.
  const next={...watch,phase,deadline:Date.now()+(phase==='receipt'?45000:30000),proof};
  await SESSION.set({watch:next,reading:{state:phase,reason,at:new Date().toISOString()}});
  return next;
}
async function checkoutScript(watch,stage,commit=false,documentId=null,proof=watch.proof,code=null) {
  const target=documentId?{tabId:watch.tabId,documentIds:[documentId]}:{tabId:watch.tabId,frameIds:[0]};
  const [frame]=await chrome.scripting.executeScript({target,func:checkoutPage,args:[stage,TARGET_ORDER,proof??null,commit,code]});
  if (!frame?.result || !frame.documentId) throw Error('The checkout document changed.');
  return frame;
}
async function confirmSavedPayment(watch,frame) {
  const {orderAttempt}=await chrome.storage.local.get('orderAttempt');
  if (!orderAttempt || orderAttempt.watchKey!==watch.key || orderAttempt.totalCents!==watch.proof.totalCents)
    return finish(watch,'review','The card prompt is not bound to the authorized order attempt.');
  if (orderAttempt.codeAttemptAt || stopRequested) return;
  let {pendingCard}=await SESSION.get('pendingCard');
  // The page already matched the drawer to the saved method charged the full
  // total. Bind the one-use code to the same watch and that exact review.
  if (pendingCard?.key!==watch.key || !watch.proof.cardTag || frame.result.cardTag!==watch.proof.cardTag)
    return finish(watch,'review','Target needs the security code for its saved card. Review the checkout tab.');
  // Consume the one-use code before entering it. Only an attempt timestamp is durable.
  await chrome.storage.local.set({orderAttempt:{...orderAttempt,codeAttemptAt:new Date().toISOString()}});
  await SESSION.remove('pendingCard');
  if (stopRequested) return;
  const {result}=await checkoutScript(watch,'fill-cvv',true,frame.documentId,watch.proof,pendingCard.code);
  pendingCard=null;
  if(result.state!=='filled') return finish(watch,'review',result.reason||'Review the security-code drawer.');
  for(let i=0;i<15 && !stopRequested;i++) {
    const answer=(await checkoutScript(watch,'confirm-cvv',true,frame.documentId)).result;
    if(answer.state==='clicked' || answer.state==='confirmed') return;
    if(answer.state!=='wait') return finish(watch,'review',answer.reason||'Target needs payment review.');
    await sleep(100);
  }
  if(!stopRequested) return finish(watch,'review','The card confirmation was not ready. Check the order before retrying.');
}
async function openCart(watch,documentId,primaryImage) {
  await stageWatch(watch,'cart','Opening the Target cart.',{primaryImage});
  if (haltBeforeOrder()) return;
  const {result}=await checkoutScript(watch,'drawer',true,documentId);
  if (result.state==='use-cart-url' && isProListing((await chrome.tabs.get(watch.tabId)).url) && !haltBeforeOrder())
    await chrome.tabs.update(watch.tabId,{url:'https://www.target.com/cart'});
  else if (result.state!=='clicked') return finish(watch,'review',result.reason||'Review the cart link.');
  scheduleCheck();
}
async function advanceCheckout(watch,tab) {
  if (stopRequested || (resetsPending && watch.phase!=='receipt')) return;
  const expired=Date.now()>watch.deadline;
  const url=tab.pendingUrl||tab.url;
  let path;
  try {
    const u=new URL(url);
    if(u.origin==='https://www.target.com') path=u.pathname.replace(/\/$/,'');
  } catch { /* The active-tab permission can be revoked on a redirect. */ }
  if (path===undefined) return finish(watch,'review','The tab left Target or requires sign-in. Review it.');
  const moving=(tab.pendingUrl && tab.pendingUrl!==tab.url) || (watch.phase==='cart' && isProListing(url)) || (watch.phase==='checkout' && path==='/cart');
  let result;
  try {
    if (!moving && tab.status!=='loading' && !tab.frozen && !tab.discarded) {
      const frame=await checkoutScript(watch,watch.phase);
      result=frame.result;
      if(result.state==='confirmed') return finish(watch,'confirmed','Target confirmed the PS5 Pro order.');
      if(result.state==='review') return finish(watch,'review',result.reason);
      if(result.state==='needs-code' && watch.phase==='receipt' && !expired && !stopRequested)
        await confirmSavedPayment(watch,frame);
      if(result.state==='ready' && !expired && !haltBeforeOrder()) {
        if (watch.phase==='cart') {
          await stageWatch(watch,'checkout','Opening checkout for one shipping PS5 Pro.',result.proof);
          if (haltBeforeOrder()) return;
          const recheck=await checkoutScript(watch,'cart',true,frame.documentId);
          if (recheck.result.state!=='clicked') return finish(watch,'review',recheck.result.reason||'The active cart changed.');
        } else if (watch.phase==='checkout') {
          // Persist intent before Place. Recovery can inspect a receipt or handle
          // its matching CVV prompt, but it must never repeat the order click.
          const locks=await chrome.storage.local.get(['cartAttempt','orderAttempt']);
          if (locks.orderAttempt || locks.cartAttempt?.watchKey!==watch.key)
            return finish(watch,'review','Order already attempted or the cart attempt changed. Check order history.');
          if (haltBeforeOrder()) return;
          const amount=result.totalCents;
          if (!Number.isSafeInteger(amount) || amount<=0 || amount>TARGET_ORDER.maxCents)
            return finish(watch,'review','The order total could not be verified within your limit.');
          if (!result.cardTag)
            return finish(watch,'review','Cannot identify the saved card at order review.');
          await chrome.storage.local.set({orderAttempt:{tcin:TARGET_ORDER.tcin,watchKey:watch.key,at:new Date().toISOString(),totalCents:amount}});
          const proof={...watch.proof,totalCents:amount,cardTag:result.cardTag};
          await stageWatch(watch,'receipt','Checking Target for order confirmation.',proof);
          if (stopRequested) return;
          const final=await checkoutScript(watch,'checkout',true,frame.documentId,proof);
          if(final.result.state!=='clicked') return finish(watch,'review',final.result.reason||'Checkout changed before submission.');
        }
      }
    }
  } catch {
    // A click can navigate before Chrome delivers its return value. Continue
    // only from the persisted next stage, never by repeating that click.
    result={reason:'The Target document changed during checkout.'};
  }
  if (expired) return finish(watch,'review',watch.phase==='receipt'?'Target did not confirm the order. Check order history before doing anything else.':result?.reason||'Checkout timed out. Review the Target tab.');
  scheduleCheck();
}
async function tryCart(watch,reading,documentId) {
  if (!documentId) return finish(watch,'review','Shipping is available. Open the tab to review the product.');
  const target={tabId:watch.tabId,documentIds:[documentId]};
  const inspect=async action=>(await chrome.scripting.executeScript({target,func:observeShipping,args:[null,'pro',action]}))[0]?.result;
  await chrome.storage.local.set({lastAvailableAt:reading.at});
  if ((await chrome.storage.local.get('cartAttempt')).cartAttempt)
    return finish(watch,'review','A previous Add was recorded. Review your Target cart.');
  await chrome.notifications.create('target-ps5-shipping',{type:'basic',iconUrl:'icon.png',title:'Target · PS5 Pro',message:'Shipping is available. Checking the Pro Add button.'}).catch(()=>{});
  let attempted=false;
  try {
    let ready=await inspect('prepare-cart');
    if (ready?.state==='selecting') {
      for (let i=0;i<8;i++) {
        await sleep(250);
        ready=await inspect('inspect-cart');
        if (ready?.state==='ready' || ready?.state==='unavailable') break;
      }
    }
    if (ready?.state==='unavailable') {await SESSION.set({reading:ready,lastConfirmed:ready}); return;}
    if (ready?.state!=='ready') return finish(watch,'review',ready?.reason||'Review Shipping and the Pro Add button.');
    // Worker tasks are serialized. Write before clicking so a timeout or worker
    // restart cannot cause another cart mutation.
    if (haltBeforeOrder()) return;
    await chrome.storage.local.set({cartAttempt:{tcin:TARGET_ORDER.tcin,watchKey:watch.key,at:new Date().toISOString()}});
    if (haltBeforeOrder()) return;
    attempted=true;
    const result=await inspect('add-one');
    if(result?.state!=='clicked') return finish(watch,'review','The product controls changed before Add. Review the Target tab.');
    for(let i=0;i<24;i++){
      const ack=(await chrome.scripting.executeScript({target,func:cartAcknowledgement,args:[result.before]}))[0]?.result;
      if (haltBeforeOrder()) return;
      if (ack && watch.autoBuy) return await openCart(watch,documentId,result.primaryImage);
      if (ack) return finish(watch,'added',ack==='item_acknowledged'?'Target acknowledged adding the PS5 Pro. Review your cart.':'Target’s cart count increased by one after the Pro Add. Review your cart.');
      await sleep(250);
    }
    return finish(watch,'review','Add attempted once. Target did not confirm it. Check your cart.');
  } catch {
    return finish(watch,'review',attempted?'Add result uncertain. Check the cart before taking any further action.':'Page changed before Add. Review the Target tab.');
  }
}
async function read(tabId,key) {
  const [r]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:observeShipping,args:[key]});
  if (!r?.result) throw Error('Could not read the Target Shipping tile.');
  return {reading:r.result,documentId:r.documentId};
}
async function handleVerification(watch,documentId) {
  if (haltBeforeOrder()) return;
  const locks=await chrome.storage.local.get(['cartAttempt','orderAttempt']);
  if (locks.cartAttempt || locks.orderAttempt)
    return finish(watch,'review','Verification appeared after a shopping attempt. Review the cart and order history.');
  if (haltBeforeOrder()) return;
  let result;
  try {
    if (!documentId) throw Error('No document identity.');
    const [frame]=await chrome.scripting.executeScript({
      target:{tabId:watch.tabId,documentIds:[documentId]},func:advanceVerification,args:[watch.key],
    });
    result=frame?.result;
    if (!result || !['verification','absent','attention'].includes(result.state)) throw Error('No verification reading.');
  } catch {
    return finish(watch,'attention','Verification handling was interrupted. Complete the prompt in the Target tab, then rearm.');
  }
  if (haltBeforeOrder()) return;
  if (result.state==='attention') return finish(watch,'attention',result.reason);
  await SESSION.set({reading:{...result,state:'verification'}});
  await badge('WAIT');
  scheduleCheck();
}
async function check(refresh=false) {
  const {watch}=await SESSION.get('watch');
  if (!watch || stopRequested || (resetsPending && watch.phase!=='receipt')) return;
  const tab=await chrome.tabs.get(watch.tabId).catch(()=>null);
  if (!tab) return finish(watch,'stopped','The watched tab closed.');
  if (watch.autoBuy && watch.phase) return advanceCheckout(watch,tab);
  if (tab.status==='loading') return;
  if (!isProListing(tab.url) || (tab.pendingUrl && !isProListing(tab.pendingUrl))) return finish(watch,'attention','The watched tab left the PS5 Pro listing.');
  if (tab.frozen || tab.discarded) {
    await SESSION.set({reading:{state:'unknown',reason:'Open the Target tab so Chrome can resume it.',at:new Date().toISOString()}});
    await badge('OPEN');return;
  }
  let reading,documentId;
  try {({reading,documentId}=await read(watch.tabId,watch.key));}
  catch {await SESSION.set({reading:{state:'unknown',reason:'Cannot read the tab yet.',at:new Date().toISOString()}});await badge('?');return;}
  if (reading.state==='verification') return handleVerification(watch,documentId);
  if (reading.state==='available' && watch.autoCart) return tryCart(watch,reading,documentId);
  if (['available','attention','away'].includes(reading.state)) {
    return finish(watch,reading.state==='away'?'attention':reading.state,reading.reason,reading.at);
  }
  await SESSION.set(reading.state==='unavailable'?{reading,lastConfirmed:reading}:{reading});
  await badge(reading.state==='unavailable'?'ON':'?');
  // Never reload an unresolved, blocked, or partly rendered page.
  if (refresh && watch.reload!==false && reading.state==='unavailable' && documentId && documentId!==watch.lastReloadDoc) {
    await SESSION.set({watch:{...watch,lastReloadDoc:documentId}});
    await chrome.tabs.reload(watch.tabId);
    await SESSION.set({lastReloadAt:new Date().toISOString()});
  }
}
async function arm(tabId,autoCart=false,reload=false,autoBuy=false,payment=null) {
  if ((await SESSION.get('watch')).watch) throw Error('A Target tab is already being watched.');
  const tab=await chrome.tabs.get(tabId);
  if (!isProListing(tab.url) || tab.incognito || tab.discarded) throw Error('Open the US Target PS5 Pro listing in this profile first.');
  const locks=await chrome.storage.local.get(['cartAttempt','orderAttempt']);
  if(autoBuy && locks.orderAttempt) throw Error('An order was already attempted. Review Target order history.');
  if(autoCart && locks.cartAttempt) throw Error('An earlier Add attempt is recorded. Review your Target cart.');
  if(payment && (!autoBuy || typeof payment.code!=='string' || !/^\d{3,4}$/.test(payment.code)))
    throw Error('An optional security code must be 3 or 4 digits and used in purchase mode.');
  stopRequested=false;
  const watch={tabId,key:crypto.randomUUID(),restoreDiscard:tab.autoDiscardable!==false,autoCart,reload,autoBuy};
  await SESSION.remove(['lastConfirmed','lastReloadAt','pendingCard']);
  watch.hasSecurityCode=Boolean(payment);
  const state={watch};
  if(payment) state.pendingCard={key:watch.key,code:payment.code};
  await SESSION.set(state);
  try {
    await chrome.tabs.update(tabId,{autoDiscardable:false});
    await chrome.alarms.create(ALARM,{periodInMinutes:INTERVAL/60});
    await check();
  } catch(e) {await finish(watch,'stopped','Setup failed. Open the listing and try again.');throw e;}
}
async function resetWatch(allowActive) {
  const {cartAttempt,orderAttempt}=await chrome.storage.local.get(['cartAttempt','orderAttempt']);
  if(orderAttempt) throw Error('An order attempt is recorded. Check Target order history. Reset is locked.');
  const {watch}=await SESSION.get('watch');
  if(watch && !allowActive) throw Error('Stop the watch before clearing its Add attempt.');
  if(watch) await finish(watch,'stopped','Watch reset before order submission.');
  if(cartAttempt) {
    await chrome.storage.local.set({previousCartAttempt:{at:cartAttempt.at,tcin:cartAttempt.tcin}});
    await chrome.storage.local.remove('cartAttempt');
  }
  await SESSION.remove(['reading','lastConfirmed','lastReloadAt','pendingCard']);
  await badge('');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if (sender.id!==chrome.runtime.id) return;
  if (sender.url===popup) {
    if (m.kind==='stop') stopRequested=true;
    if (m.kind==='reset-watch') resetsPending++;
    serial(async()=>{
      if (m.kind==='arm') await arm(m.tabId,m.autoCart===true||m.autoBuy===true,m.reload===true,m.autoBuy===true,m.payment);
      if (m.kind==='reset-watch') {
        try {await resetWatch(true);} finally {resetsPending--;}
      }
      if (m.kind==='reset-cart') await resetWatch(false);
      if (m.kind==='stop') {
        const {watch}=await SESSION.get('watch');
        if (watch) await finish(watch,'stopped','Stopped.');
      }
      return {...await SESSION.get(['watch','reading','lastConfirmed','lastReloadAt']),...await chrome.storage.local.get(['lastAvailableAt','cartAttempt','previousCartAttempt','orderAttempt','lastPurchaseResult'])};
    }).then(reply,e=>reply({error:e.message}));return true;
  }
  if (m.kind==='reading' && sender.frameId===0 && isProListing(sender.url)) {
    serial(async()=>{
      const {watch}=await SESSION.get('watch');
      if(watch?.key===m.key && watch.tabId===sender.tab?.id) await check();
    }).then(()=>reply({}),()=>reply({}));return true;
  }
});
let refreshPending=false;
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name!==ALARM || refreshPending) return;
  refreshPending=true;
  void serial(()=>check(true)).catch(()=>{}).finally(()=>{refreshPending=false;});
});
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(change.status!=='complete' && !('url' in change) && !('frozen' in change)) return;
  void serial(async()=>{if((await SESSION.get('watch')).watch?.tabId===id) await check();});
});
chrome.tabs.onRemoved.addListener(id=>{void serial(async()=>{
  const {watch}=await SESSION.get('watch');
  if (watch?.tabId===id) await finish(watch,'stopped','The watched tab closed.');
});});
