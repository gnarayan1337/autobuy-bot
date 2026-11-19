// Only the selected, signed-in Sony tab supplies inventory. Alarms may reload
// an unavailable document. Page mutations and navigation events only inspect it.
import {sonyPage, cartConfirmation, observeOffer} from './page.js';

const PRO='https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console';
const session=chrome.storage.session;
const local=chrome.storage.local;
const alarmName='maintain';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const isPro=url=>{try{const u=new URL(url);return u.origin+u.pathname.replace(/\/$/,'')===PRO;}catch{return false;}};
let pending=Promise.resolve(), generation=0, alarmPending=false;
function serial(task) {
  const next=pending.then(task);
  pending=next.catch(()=>{});
  return next;
}
async function note(message,badge='ON') {
  if((await session.get('note')).note!==message) await session.set({note:message});
  await chrome.action.setBadgeText({text:badge});
}
async function notify(id,message) {
  await chrome.notifications.create(id,{type:'basic',iconUrl:'icon.png',title:'PS5 Pro · PlayStation Direct',message}).catch(()=>{});
}
async function logEvent(arm,stream,event,at=new Date().toISOString()) {
  const {events=[]}=await local.get('events');
  if(events.findLast(e=>e.arm===arm.since && e.stream===stream)?.event===event) return false;
  await local.set({events:[...events,{arm:arm.since,stream,event,at}].slice(-100)});
  return true;
}
async function inTab(tabId,func,args=[],doc=null) {
  const target=doc?{tabId,documentIds:[doc]}:{tabId,frameIds:[0]};
  const [frame]=await chrome.scripting.executeScript({target,func,args});
  if(!frame?.documentId) throw Error('Document unavailable');
  return frame;
}
async function finish(arm,message,badge='') {
  await session.remove('arm');
  await chrome.alarms.clear(alarmName);
  if(arm.observedDoc) await inTab(arm.tabId,observeOffer,[arm.key,false],arm.observedDoc).catch(()=>{});
  if(arm.wasDiscardable) await chrome.tabs.update(arm.tabId,{autoDiscardable:true}).catch(()=>{});
  await note(message,badge);
  if(badge==='CART'||badge==='CHK') await notify('ps5-cart',message);
}
const holds={
  waiting:'Waiting in the original Sony queue.', paused:'Sony has paused the line.',
  estimate:'Sony is showing a wait estimate.', turn_prompt:'Check the Sony tab for your turn.',
  off_listing:'The armed tab left the Pro listing. Follow Sony’s instructions in that tab.',
  verification:'Sony is requesting verification or has declined access. Review the tab.',
  frozen:'Open the armed tab so Chrome can resume it.', signed_out:'Sign in on the armed Sony tab.',
  account_unknown:'Waiting for Sony to confirm sign-in.', conflict:'The Add button and Currently Unavailable are both visible.',
};
async function recordReading(arm,state,doc) {
  const checkedAt=new Date().toISOString();
  await session.set({pageReading:{state,checkedAt}});
  if(holds[state]) {
    if(await logEvent(arm,'tab',state,checkedAt)) await notify('ps5-wait',holds[state]);
    if(!arm.held){arm.held=true;await session.set({arm});}
    await note(holds[state],'WAIT');
    return checkedAt;
  } else if(arm.held && ['unavailable','ready','already_added'].includes(state)){
    arm.held=false;await session.set({arm});await logEvent(arm,'tab','product_page_returned',checkedAt);
  }
  if(doc && arm.observedDoc!==doc){
    await inTab(arm.tabId,observeOffer,[arm.key,true],doc);
    arm.observedDoc=doc;await session.set({arm});
  }
  return checkedAt;
}
async function add(arm,frame,at,token) {
  if(token!==generation) return;
  if((await local.get('attempt')).attempt) return finish(arm,'A previous Pro Add is recorded. Check your cart.','CHK');
  if(token!==generation) return;
  // A lost click result cannot be retried. Persist before sending the action.
  await local.set({attempt:{sku:'1000050805',restockAt:at,at:Date.now()}});
  if(token!==generation) return;
  try {
    const {result}=await inTab(arm.tabId,sonyPage,['add','pro'],frame.documentId);
    if(result?.state!=='clicked') return finish(arm,'The offer or sign-in changed before Add. Review the tab.','CHK');
    await logEvent(arm,'cart','add_clicked');
    for(let i=0;i<12 && token===generation;i++){
      if((await inTab(arm.tabId,cartConfirmation,[result.before,'pro'],frame.documentId)).result){
        await logEvent(arm,'cart','add_acknowledged');
        return finish(arm,'Sony acknowledged one Pro Add. Review your cart.','CART');
      }
      await pause(300);
    }
  } catch { /* Navigation can interrupt an acknowledgement after a real click. */ }
  if(token===generation) {
    await logEvent(arm,'cart','add_unconfirmed');
    await finish(arm,'Add result uncertain. Review the cart before taking further action.','CHK');
  }
}
async function check(refresh,token,key) {
  const {arm}=await session.get('arm');
  if(!arm || token!==generation || (key && arm.key!==key)) return;
  const tab=await chrome.tabs.get(arm.tabId).catch(()=>null);
  if(!tab) return finish(arm,'The armed tab closed.');
  if(!isPro(tab.url)||(tab.pendingUrl && !isPro(tab.pendingUrl))) return recordReading(arm,'off_listing');
  if(tab.frozen||tab.discarded) return recordReading(arm,'frozen');
  if(tab.status==='loading'||tab.pendingUrl) return;

  try {
    const frame=await inTab(arm.tabId,sonyPage,['inspect','pro']);
    if(token!==generation) return;
    const state=frame.result?.state||'loading';
    const reading=state==='queue'?frame.result.detail:state;
    const at=await recordReading(arm,reading,frame.documentId);
    if(token!==generation || holds[reading]) return;
    if(state==='already_added') return finish(arm,'Sony already shows the Pro was added. Review your cart.','CART');
    if(state==='ready'){
      await logEvent(arm,'offer','in_stock',at);
      await notify('ps5-restock','The signed-in Sony Pro page shows Add. Checking the control once.');
      return add(arm,frame,at,token);
    }
    if(state!=='unavailable') {
      await note('Waiting for the Pro controls to finish rendering.','…');return;
    }
    await logEvent(arm,'offer','currently_unavailable',at);
    await note('Armed. Sony shows Currently Unavailable.');
    if(!refresh || arm.lastReloadDoc===frame.documentId || token!==generation) return;
    arm.lastReloadDoc=frame.documentId;
    await session.set({arm});
    if(token!==generation) return;
    // Revalidate the exact document and its controls at the instant of reload.
    const reload=await inTab(arm.tabId,sonyPage,['reload-unavailable','pro'],frame.documentId);
    if(reload.result?.state==='reloading') await session.set({lastReloadAt:new Date().toISOString()});
    else {delete arm.lastReloadDoc;await session.set({arm});}
  } catch {
    if(token===generation) await note('The Sony document changed or could not be read. Waiting for the next check.','WAIT');
  }
}
async function armTab(tabId,token) {
  if((await session.get('arm')).arm) throw Error('Disarm the existing tab first.');
  const tab=await chrome.tabs.get(tabId);
  if(!isPro(tab.url)||tab.incognito||tab.discarded||tab.frozen) throw Error('Open the signed-in US PS5 Pro listing in this profile.');
  const {result}=await inTab(tabId,sonyPage,['inspect','pro']);
  if(!['ready','unavailable'].includes(result?.state)) throw Error('Wait for the signed-in product controls. Current state: '+result?.state);
  if((await local.get('attempt')).attempt) throw Error('A previous Add attempt is recorded. Review your cart.');
  if(token!==generation) return;
  const arm={tabId,key:crypto.randomUUID(),since:Date.now(),wasDiscardable:tab.autoDiscardable!==false};
  await session.remove(['publicReading','pageReading','lastReloadAt']);
  await session.set({arm});
  try {
    await chrome.tabs.update(tabId,{autoDiscardable:false});
    await chrome.alarms.create(alarmName,{periodInMinutes:3/60});
    await logEvent(arm,'watch','armed');
    await check(false,token,arm.key);
  } catch(error) {await finish(arm,'Could not start the watch.');throw error;}
}
async function testBase(tabId) {
  const frame=await inTab(tabId,sonyPage,['inspect','base']);
  if(frame.result?.state!=='ready') throw Error('Base test needs a signed-in listing with an enabled Add. Current state: '+frame.result?.state);
  const {baseCartTrial:prior}=await local.get('baseCartTrial');
  if(prior && frame.result.before!==0) throw Error('An earlier base Add is recorded. Check the active cart before another test.');
  const trial={sku:'1000049888',at:Date.now(),result:'reserved'};
  await local.set({baseCartTrial:trial});
  let result='unconfirmed';
  try {
    const click=await inTab(tabId,sonyPage,[prior?'repeat-base-add':'add','base'],frame.documentId);
    if(click.result.state!=='clicked') result='controls_changed';
    else for(let i=0;i<12;i++){
      if((await inTab(tabId,cartConfirmation,[click.result.before,'base'],frame.documentId)).result){result='acknowledged';break;}
      await pause(300);
    }
  } catch { /* Never retry a live cart mutation on an ambiguous response. */ }
  await local.set({baseCartTrial:{...trial,result}});
  return {ok:result==='acknowledged',note:result==='acknowledged'?'Sony acknowledged the base PS5 Add. Review the cart.':
    'Base test result: '+result+'. Review the cart.'};
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.url===chrome.runtime.getURL('popup.html')){
    if(msg.type==='disarm') generation++;
    const token=generation;
    serial(async()=>{
      if(msg.type==='test-base') return testBase(msg.tabId);
      if(msg.type==='arm') await armTab(msg.tabId,token);
      if(msg.type==='disarm'){const {arm}=await session.get('arm');if(arm)await finish(arm,'Disarmed.');}
      const {arm,note:message}=await session.get(['arm','note']);
      return {ok:true,armed:!!arm,note:message||'Open the signed-in Sony Pro tab and arm it.'};
    }).then(reply,e=>reply({ok:false,note:e.message}));
    return true;
  }
  if(msg.type==='offer-changed' && sender.id===chrome.runtime.id && sender.frameId===0 && isPro(sender.url)){
    const token=generation;
    serial(async()=>{
      const {arm}=await session.get('arm');
      if(arm?.tabId===sender.tab?.id && arm.key===msg.key) await check(false,token,msg.key);
    }).then(()=>reply({}),()=>reply({}));
    return true;
  }
});
chrome.tabs.onRemoved.addListener(id=>{void serial(async()=>{
  const {arm}=await session.get('arm');if(arm?.tabId===id)await finish(arm,'The armed tab closed.');
}).catch(()=>{});});
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(!('url' in change || change.status==='complete' || 'frozen' in change || 'discarded' in change)) return;
  const token=generation;
  void serial(async()=>{if((await session.get('arm')).arm?.tabId===id)await check(false,token);}).catch(()=>{});
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name!==alarmName||alarmPending)return;
  const token=generation;
  alarmPending=true;
  return serial(()=>check(true,token)).finally(()=>{alarmPending=false;});
});
