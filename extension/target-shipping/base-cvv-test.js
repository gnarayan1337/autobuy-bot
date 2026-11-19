import {checkoutPage} from './checkout.js';

// This test has no confirm-cvv action, including after an ambiguous response.
const base={tcin:'94961316',name:'PlayStation 5 Console - Digital Edition',zip:'75013',maxCents:64949};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function prepareBaseCvvTest(ticket,status,passed) {
  const {tabId,documentId}=ticket;
  const inspect=async(stage,proof,commit=false,doc=null,code=null)=>{
    const target=doc?{tabId,documentIds:[doc]}:{tabId,frameIds:[0]};
    const [frame]=await chrome.scripting.executeScript({target,func:checkoutPage,args:[stage,base,proof,commit,code]});
    if(!frame?.documentId || !frame.result) throw Error('The checkout document is unavailable.');
    return frame;
  };
  let proof={tcin:base.tcin,images:[]};
  document.title='One-time Target base CVV test';
  document.querySelector('h1').textContent=document.title;
  const first=await inspect('checkout',proof,false,documentId);
  if(first.result.state!=='ready'){status.textContent=first.result.reason;return;}
  proof={...proof,totalCents:first.result.totalCents,cardTag:first.result.cardTag};
  const amount='$'+(proof.totalCents/100).toFixed(2);
  status.textContent='One shipped Digital Edition, '+amount+'. Target may place this order immediately. If it asks for CVV, the test fills the field and stops.';
  const fields=document.createElement('div'), code=document.createElement('input');
  const label=document.createElement('label');
  label.textContent='One-time security code ';
  code.type='password';code.inputMode='numeric';code.autocomplete='off';code.maxLength=4;code.size=5;
  label.append(code);fields.append(label,document.createElement('br'));
  const start=document.createElement('button');start.type='button';start.textContent='Click Place your order once · '+amount;
  fields.append(start);document.body.append(fields);
  start.onclick=async()=>{
    if(!/^\d{3,4}$/.test(code.value)){
      status.textContent='Enter a 3- or 4-digit security code for the reviewed saved card.';return;
    }
    let secret=code.value;
    code.value='';start.disabled=true;fields.remove();
    try{
      await navigator.locks.request('target-base-rehearsal',{ifAvailable:true},async lock=>{
        if(!lock || (await chrome.storage.local.get('baseCvvTestAttempt')).baseCvvTestAttempt) throw Error('An attempt is already recorded. Review the Target tab.');
        const ready=await inspect('checkout',proof,false,documentId);
        if(ready.result.state!=='ready') throw Error(ready.result.reason);
        const record={tcin:base.tcin,totalCents:proof.totalCents,at:new Date().toISOString()};
        await chrome.storage.local.set({baseCvvTestAttempt:record});
        // Navigation can destroy the first frame immediately after the click.
        // Only observe the result in that case. Never repeat the order action.
        let action;
        try{action=(await inspect('base-try-place',proof,true,documentId)).result;}catch{}
        if(action && action.state!=='clicked') throw Error(action.reason||'Order review changed.');
        passed(action?'Clicked Place your order once for '+amount+'.':'The checkout document changed during the single attempt.');
        status.textContent='Watching for Target’s CVV drawer or order confirmation.';
        const end=Date.now()+30000;
        while(Date.now()<end){
          let frame;
          try{frame=await inspect('receipt',proof);}catch{await pause(150);continue;}
          if(frame.result.state==='confirmed'){
            secret=null;
            await chrome.storage.local.set({baseCvvTestAttempt:{...record,outcome:'confirmed'}});
            passed('Target confirmed the base order.');
            status.textContent='Target accepted the order without requiring this test to enter a code.';return;
          }
          if(frame.result.state==='review') throw Error(frame.result.reason);
          if(frame.result.state==='needs-code'){
            passed('Detected the real Confirm CVV drawer on the reviewed base order.');
            const filled=(await inspect('base-fill-stop',proof,true,frame.documentId,secret)).result;
            secret=null;
            if(filled.state!=='filled') throw Error(filled.reason||'Card-code entry is unverified.');
            await chrome.storage.local.set({baseCvvTestAttempt:{...record,outcome:'filled-stopped',filledAt:new Date().toISOString()}});
            passed('Verified the field accepted the code. Confirm was never clicked.');
            status.textContent='Stopped with the CVV drawer open on Target.';
            await chrome.tabs.update(tabId,{active:true});return;
          }
          await pause(150);
        }
        throw Error('Target did not show a verifiable result. Check the original tab before taking any further action.');
      });
    }catch(error){status.textContent=error.message;}finally{secret=null;}
  };
}
