const statusLine=document.querySelector('#status'), button=document.querySelector('#action');
let armed=false;
function show(r) {
  statusLine.textContent=r.note;
  if (r.ok) armed=r.armed;
  button.textContent=armed?'Disarm':'Arm this tab'; button.disabled=false;
}
const fail=e=>show({ok:false,note:e.message});
chrome.runtime.sendMessage({type:'status'}).then(async r=>{
  show(r);
  if(!r.ok||r.armed) return;
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.url || new URL(tab.url).origin+new URL(tab.url).pathname.replace(/\/$/,'')!=='https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console') return;
  const {sonyPage}=await import('./page.js');
  const [probe]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:sonyPage,args:['inspect','pro']});
  if(armed)return;
  const preview=document.createElement('p');
  const state=probe?.result?.state;
  preview.textContent=state==='unavailable'?'Currently Unavailable. Arming will refresh this tab.':
    state==='ready'?'Add is available. Arming can add one Pro immediately.':'Current page state: '+(state||'unknown')+'.';
  document.body.append(preview);
}).catch(fail);
button.onclick=async()=>{
  button.disabled=true;
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    show(await chrome.runtime.sendMessage({type:armed?'disarm':'arm',tabId:tab.id}));
  } catch(e) {fail(e);}
};

// An explicitly clicked base-console test is separate from the Pro alarm and its attempt lock.
async function offerBaseTrial() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.url || new URL(tab.url).origin + new URL(tab.url).pathname !== 'https://direct.playstation.com/en-us/buy-consoles/playstation5-console-1-tb') return;
  const testButton=document.createElement('button'), outcome=document.createElement('p');
  outcome.setAttribute('role','status');document.body.append(testButton,outcome);
  const {baseCartTrial}=await chrome.storage.local.get('baseCartTrial');
  testButton.textContent=baseCartTrial?'Retest base Add with empty cart':'Test: add one base PS5';
  if(baseCartTrial) {
    outcome.textContent='Previous base test: '+(baseCartTrial.result||'attempt recorded')+'.';
    const check=document.createElement('button');
    check.textContent='Verify base item in open cart';document.body.append(check);
    check.onclick=async()=>{
      try {
        const {cartConfirmation}=await import('./page.js');
        const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:cartConfirmation,args:[null,'base']});
        outcome.textContent=r?.result?'Verified one base PS5 in the open Sony cart.':'Cannot verify the base line. Check the open cart.';
        if(r?.result) await chrome.storage.local.set({baseCartTrial:{...baseCartTrial,result:'acknowledged',verifiedAt:new Date().toISOString()}});
      } catch {outcome.textContent='Cannot read the original base tab.';}
    };
  }
  testButton.onclick=async()=>{
    testButton.disabled=true;
    try {
      const r=await chrome.runtime.sendMessage({type:'test-base',tabId:tab.id});
      outcome.textContent=r.note;
    } catch {outcome.textContent='Test result uncertain. Review the cart.';}
  };
}
offerBaseTrial().catch(e=>{statusLine.textContent=e.message;});

// A running unpacked extension can update its existing alarm without unloading the
// worker, losing its tab binding, or clearing the one-attempt lock.
async function watchStatus() {
  const {arm}=await chrome.storage.session.get('arm');
  if (!arm) return;
  const panel=document.createElement('p'), speed=document.createElement('button');
  const selected=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
  if(selected?.id!==arm.tabId) {
    const locate=document.createElement('button');
    locate.textContent='Show armed Pro tab';
    locate.onclick=()=>chrome.tabs.update(arm.tabId,{active:true});
    document.body.append(locate);
  }
  speed.textContent='Use 3-second checks';
  document.body.append(panel,speed);
  async function update() {
    const {arm,pageReading,note,lastReloadAt}=await chrome.storage.session.get(['arm','pageReading','note','lastReloadAt']);
    const alarm=await chrome.alarms.get('maintain');
    if (note) show({ok:true,armed:!!arm,note});
    const interval=alarm?.periodInMinutes;
    panel.textContent=arm ? 'Version '+chrome.runtime.getManifest().version+(selected?.id===arm.tabId?' · This tab is armed. ':' · Another Pro tab is armed. ')+'Requested interval: '+(interval?Math.round(interval*60)+' seconds':'unknown')+
      '. Last page reading: '+(pageReading?.checkedAt || 'waiting')+' ('+(pageReading?.state||'unknown')+').'+
      (lastReloadAt?' Last page refresh: '+lastReloadAt+'.':'') : '';
    speed.hidden=!arm || (interval && interval<=3/60);
  }
  speed.onclick=async()=>{
    if(!(await chrome.storage.session.get('arm')).arm) return;
    await chrome.alarms.create('maintain',{periodInMinutes:3/60});
    await update();
  };
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='session' && ('arm' in changes || 'note' in changes || 'pageReading' in changes)) void update();
  });
  await update();
}
watchStatus().catch(fail);

// Exercise the real Chrome/macOS notification path without changing stock or cart state.
const alertTest=document.createElement('button'), alertTestStatus=document.createElement('p');
alertTest.textContent='Test Chrome notification';alertTestStatus.setAttribute('role','status');
document.body.append(alertTest,alertTestStatus);
alertTest.onclick=async()=>{
  try {
    const permission=await chrome.notifications.getPermissionLevel();
    if(permission!=='granted') {alertTestStatus.textContent='Chrome notification permission is '+permission+'.';return;}
    await chrome.notifications.create('ps5-notification-test',{type:'basic',iconUrl:'icon.png',
      title:'PS5 watch · test only',message:'This is a notification test. No restock or cart action.'});
    alertTestStatus.textContent='Test sent to Chrome. No banner? Check System Settings → Notifications → Google Chrome and Google Chrome Helper (Alerts).';
  } catch (e) {alertTestStatus.textContent=e.message;}
};

const history=document.createElement('details'), historyTitle=document.createElement('summary'), historyList=document.createElement('ol');
historyTitle.textContent='Detection times';history.append(historyTitle,historyList);document.body.append(history);
async function showEvents() {
  const {events=[]}=await chrome.storage.local.get('events');
  historyList.replaceChildren();
  const time=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'short'});
  for(const entry of events.slice(-100).reverse()){
    const item=document.createElement('li');
    const detail=[entry.reason?.replaceAll('_',' '),entry.httpStatus?'HTTP '+entry.httpStatus:''].filter(Boolean);
    item.textContent=[time.format(new Date(entry.at)),entry.stream,entry.event.replaceAll('_',' '),...detail].join(' · ');
    item.title=entry.at;
    historyList.append(item);
  }
}
history.addEventListener('toggle',()=>{if(history.open)void showEvents();});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.events && history.open)void showEvents();});
