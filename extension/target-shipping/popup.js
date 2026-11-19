import {isProListing,TARGET_PRO_URL} from './checkout.js';

const statusText=document.querySelector('#status'),when=document.querySelector('#when'),toggle=document.querySelector('#toggle');
const mode=document.querySelector('#mode'), reload=document.querySelector('#reload');
const historyText=document.querySelector('#history'), reset=document.querySelector('#reset');
const resetHelp=document.querySelector('#reset-help'), openPro=document.querySelector('#open-pro');
const paymentBox=document.querySelector('#payment'), security=document.querySelector('#security');
const localKeys=['lastAvailableAt','cartAttempt','previousCartAttempt','orderAttempt','lastPurchaseResult'];
let watching=false, changing=false, canToggle=false, canReset=false;
function setButtons() {
  toggle.disabled=changing||!canToggle;
  reset.disabled=changing||!canReset;
}
const localTime=iso=>new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'short'}).format(new Date(iso));
async function update(kind='status') {
  let r;
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(kind==='status') {
    r={...await chrome.storage.session.get(['watch','reading','lastConfirmed','lastReloadAt']),...await chrome.storage.local.get(localKeys)};
  } else {
    const msg={kind,tabId:tab?.id,autoCart:mode.value!=='alert',autoBuy:mode.value==='buy',reload:reload.checked};
    if(kind==='arm' && msg.autoBuy && security.value) {
      if (!/^\d{3,4}$/.test(security.value)) {
        statusText.textContent='Enter a 3- or 4-digit security code, or leave it blank.';
        security.focus();
        return;
      }
      msg.payment={code:security.value};
      security.value='';
    }
    r=await chrome.runtime.sendMessage(msg);
  }
  if (r.error) {statusText.textContent=r.error;return;}
  watching=!!r.watch;
  if(watching){mode.value=r.watch.autoBuy?'buy':r.watch.autoCart?'cart':'alert';reload.checked=r.watch.reload!==false;}
  const onPro=isProListing(tab?.url)&&!tab?.incognito&&!tab?.discarded&&(!tab.pendingUrl||isProListing(tab.pendingUrl));
  const orderBlocked=mode.value==='buy' && !!r.orderAttempt;
  const addBlocked=mode.value!=='alert' && !!r.cartAttempt;
  canToggle=watching || (onPro && !orderBlocked && !addBlocked);
  canReset=!r.orderAttempt && Boolean(watching || r.reading || r.cartAttempt);
  setButtons();
  mode.disabled=reload.disabled=watching;
  paymentBox.hidden=watching||mode.value!=='buy'||!canToggle;
  if(paymentBox.hidden || kind==='reset-watch') security.value='';
  const loadingWithPrior=watching && r.reading?.state==='unknown' && r.lastConfirmed;
  const shown=loadingWithPrior?r.lastConfirmed:r.reading;
  if(watching) statusText.textContent='Watching. '+(loadingWithPrior?'Last confirmed: ':'')+(shown?.label||shown?.reason||'Waiting for a stock reading.');
  else if(orderBlocked) statusText.textContent='An order attempt is recorded. Check Target order history.';
  else if(addBlocked) statusText.textContent='An Add attempt is recorded. Check the active cart before resetting.';
  else if(!onPro) statusText.textContent='Open the Target PS5 Pro listing to arm this watch.';
  else statusText.textContent='Ready to arm this PS5 Pro tab.';
  when.textContent=watching && r.reading?.at?'Checked '+localTime(r.reading.at):'';
  openPro.hidden=watching||onPro;
  if(watching){
    const a=await chrome.alarms.get('check-shipping');
    if(a) when.textContent+=' · '+(r.watch.reload!==false?'Refresh requested every ':'Read the open tab every ')+Math.round(a.periodInMinutes*60)+' seconds.';
    when.textContent+=r.watch.autoBuy?' One Pro order armed, up to $1,100 total.':r.watch.autoCart?' One shipping Add armed.':' Alerts only.';
    if(r.watch.hasSecurityCode && !r.orderAttempt?.codeAttemptAt) when.textContent+=' One-use card code ready.';
    if(r.lastReloadAt) when.textContent+=' Last refresh: '+localTime(r.lastReloadAt)+'.';
    if(loadingWithPrior) when.textContent+=' '+r.reading.reason+' Last confirmed at '+localTime(r.lastConfirmed.at)+'.';
  }
  toggle.textContent=watching?'Stop watching':mode.value==='buy'?'Arm one Pro purchase · $1,100 max':'Watch this tab';
  reset.hidden=false;
  reset.textContent=r.cartAttempt && !r.orderAttempt?'Reset Add attempt':'Reset watch';
  resetHelp.hidden=!r.orderAttempt && !canReset;
  resetHelp.textContent=r.orderAttempt?'Reset is locked after an order attempt.':r.cartAttempt?'Use after checking your cart. Reset stops this watch and lets you arm again.':watching?'Stop this watch and keep its history.':'Clear the previous watch status and keep its history.';
  const events=[];
  if(r.lastAvailableAt) events.push('Shipping detected '+localTime(r.lastAvailableAt)+'.');
  if(r.previousCartAttempt) events.push('Previous Add attempt '+localTime(r.previousCartAttempt.at)+'.');
  if(r.cartAttempt) events.push('Add attempt '+localTime(r.cartAttempt.at)+'.');
  if(r.orderAttempt) events.push('Order attempt '+localTime(r.orderAttempt.at)+' for $'+(r.orderAttempt.totalCents/100).toFixed(2)+'.');
  const lastResult=!watching && r.reading ? r.reading : r.lastPurchaseResult;
  if(lastResult) events.push('Previous result · '+localTime(lastResult.at)+' · '+(lastResult.reason||lastResult.label||lastResult.state));
  historyText.hidden=!events.length;
  historyText.textContent=events.join(' ');
}
const fail=e=>{statusText.textContent=e.message;};
async function command(kind) {
  if(changing) return;
  changing=true;setButtons();
  try {await update(kind);}catch(e){fail(e);}
  finally {changing=false;setButtons();}
}
toggle.onclick=()=>command(watching?'stop':'arm');
chrome.storage.onChanged.addListener((changes,area)=>{
  if(!changing && ((area==='session' && (changes.watch||changes.reading||changes.lastReloadAt)) ||
      (area==='local' && localKeys.some(key=>key in changes)))) update().catch(fail);
});
mode.onchange=()=>update().catch(fail);
reset.onclick=()=>command('reset-watch');
openPro.onclick=()=>chrome.tabs.create({url:TARGET_PRO_URL}).catch(fail);
update().catch(fail);

// Manual diagnostics have separate actions for a stock read, a cart rehearsal,
// and the single-use base order test. None arms a second Pro watch.
async function baseCheck() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.url) return;
  const u=new URL(tab.url);
  if(u.origin==='https://www.target.com' && u.pathname==='/checkout') {
    const {checkoutPage,TARGET_ORDER}=await import('./checkout.js');
    const base={...TARGET_ORDER,tcin:'94961316',name:'PlayStation 5 Console - Digital Edition',maxCents:64949};
    const [frame]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:checkoutPage,args:['checkout',base,{tcin:base.tcin,images:[]},false]});
    if(frame?.result?.state!=='ready' || (await chrome.storage.local.get('baseCvvTestAttempt')).baseCvvTestAttempt) return;
    const start=document.createElement('button');start.textContent='Open one-time base CVV test';
    document.body.append(start);
    start.onclick=async()=>{
      start.disabled=true;
      try{
        const ticket=crypto.randomUUID();
        await chrome.storage.session.set({baseRehearsalTicket:{ticket,tabId:tab.id,documentId:frame.documentId,mode:'live-cvv'}});
        await chrome.tabs.create({url:chrome.runtime.getURL('rehearse.html')+'#'+ticket});
      }catch{statusText.textContent='Could not open the base test.';start.disabled=false;}
    };
    return;
  }
  if(u.origin!=='https://www.target.com'||!/^\/p\/(?:[^/]+\/)?-\/A-94961316\/?$/.test(u.pathname))return;
  const check=document.createElement('button'), answer=document.createElement('p');
  check.textContent='Check base PS5 Shipping once';answer.setAttribute('role','status');document.body.append(check,answer);
  check.onclick=async()=>{
    check.disabled=true;
    try {
      const {observeShipping}=await import('./shipping.js');
      const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:observeShipping,args:[null,'base']});
      answer.textContent='Base Digital Edition: '+r.result.state+'. '+(r.result.label||r.result.reason)+' · '+localTime(r.result.at);
    } catch(e) {answer.textContent=e.message;}
    finally {check.disabled=false;}
  };
  const trial=document.createElement('button');
  trial.textContent='Rehearse base checkout without ordering';
  document.body.append(trial);
  trial.onclick=async()=>{
    trial.disabled=true;
    try {
      const ticket=crypto.randomUUID();
      await chrome.storage.session.set({baseRehearsalTicket:{ticket,tabId:tab.id}});
      await chrome.tabs.create({url:chrome.runtime.getURL('rehearse.html')+'#'+ticket});
    } catch {answer.textContent='Could not open the rehearsal.';trial.disabled=false;}
  };
}
baseCheck().catch(fail);
