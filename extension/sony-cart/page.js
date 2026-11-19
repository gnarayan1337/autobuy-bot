// This function is serialized by chrome.scripting. It must be self-contained.
export function sonyPage(action = 'inspect', model = 'pro') {
  const base = model === 'base';
  const productPath = base ? '/en-us/buy-consoles/playstation5-console-1-tb' : '/en-us/buy-consoles/playstation5-pro-console';
  const sku = base ? '1000049888' : '1000050805';
  const title = base ? 'PlayStation®5 Console - 1 TB' : 'PlayStation®5 Pro Console';
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
  const norm = str => (str || '').replace(/\s+/g,' ').trim();
  if (location.origin !== 'https://direct.playstation.com' || location.pathname.replace(/\/$/,'') !== productPath) return {state:'away'};
  const text = document.body?.innerText || '';
  // Historical US Sony waiting room, September 26, 2024:
  // https://cdn.mos.cms.futurecdn.net/bg8Xaz5B8KwbtAcSzn29TV.jpg
  const words = norm(text);
  // Status lines also appear in the September 2026 US controller sale screenshots.
  const waiting = /you have been temporarily placed in a waiting room|the line is paused|you(?:’re|'re| are) (?:in (?:the )?(?:queue|line)|in a waiting room)|estimated wait time|do not refresh|please wait for your turn|you are now in line|virtual waiting room/i.test(words);
  const prompt = [...document.querySelectorAll('h1,h2,h3,[role="dialog"]')].some(el =>
    visible(el) && /^(?:it is|it['’]s) your turn\b/i.test(norm(el.innerText)));
  if (waiting || prompt) {
    const detail = prompt ? 'turn_prompt' : /the line is paused/i.test(words) ? 'paused'
      : /your estimated wait time is/i.test(words) ? 'estimate' : 'waiting';
    return {state:'queue',detail,detectedAt:new Date().toISOString()};
  }
  if (/verify (?:that )?you are human|human verification|press (?:and|&) hold|access denied|unusual traffic|too many requests|service unavailable/i.test(text) ||
      [...document.querySelectorAll('iframe[title*="challenge" i],iframe[title*="verification" i],input[autocomplete="one-time-code"]')].some(visible))
    return {state:'verification'};
  const onScreen = el => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  };
  if ([...document.querySelectorAll('h1,h2,h3,h4')].some(el => onScreen(el) && /your session has timed out/i.test(el.innerText))) return {state:'signed_out'};
  const products = [...document.querySelectorAll('[itemtype$="schema.org/Product"]')].filter(p =>
    p.querySelector('meta[itemprop="sku"][content="' + sku + '"]'));
  if (products.length !== 1 || norm(document.querySelector('h1')?.innerText) !== title ||
      document.querySelector('link[rel="canonical"]')?.href !== location.origin + productPath) return {state:'loading'};
  const shown = query => [...document.querySelectorAll(query)].some(visible);
  const signedOut = shown('.js-topnav-desktop-signin-link,.js-topnav-mobile-signin-link');
  const signedIn = !signedOut && (shown('.js-topnav-desktop-signout-link,.js-topnav-mobile-signout-link') ||
    (shown('.js-topnav-desktop-profile-icon,.js-topnav-mobile-signedin-wrapper') && !!document.querySelector('.js-profile-menu-username')?.textContent.trim()));
  if (!signedIn) return {state:signedOut ? 'signed_out' : 'account_unknown'};
  const product = products[0];
  const belongs=el=>el.closest('[itemtype$="schema.org/Product"]')===product;
  const panels=[...product.querySelectorAll('producthero-info,producthero-mobile-price')].filter(belongs);
  // The storefront ships hidden templates for both states. Read only controls
  // displayed for this product, regardless of stale or absent offer metadata.
  const unavailable=panels.some(panel=>[...panel.querySelectorAll('.out-stock-wrpr, .js-currently-unavailable-wrpr, p, span')]
    .some(el=>belongs(el) && visible(el) && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
      /^currently unavailable$/i.test(norm(el.innerText))));
  const selector = 'button.add-to-cart[data-product-code="'+sku+'"]';
  const enabled = el => {
    const bounds = el.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 &&
      /^add(?: to (?:shopping )?cart)?$/i.test(norm(el.getAttribute('aria-label')||el.innerText)) &&
      el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
      !el.matches(':disabled') && !el.closest('[inert],[aria-disabled="true"]') &&
      getComputedStyle(el).pointerEvents !== 'none' &&
      el.closest('[itemtype$="schema.org/Product"]') === product;
  };
  // Both controls occur in Sony's product HTML. Prefer the primary panel when
  // both it and its mobile counterpart are visible, and choose at most one.
  let buttons = [...product.querySelectorAll('producthero-info '+selector)].filter(enabled);
  if (!buttons.length) buttons = [...product.querySelectorAll('producthero-mobile-price '+selector)].filter(enabled);
  if(unavailable) {
    if(buttons.length) return {state:'conflict'};
    if(action==='reload-unavailable' && !base) {location.reload();return {state:'reloading'};}
    return {state:'unavailable'};
  }
  if (buttons.length !== 1) return {state:'loading'};
  const counts = [...document.querySelectorAll('.js-mini-cart-count')].filter(visible)
    .map(el=>norm(el.innerText)).filter(s=>/^\d+$/.test(s)).map(Number);
  for(const el of [...document.querySelectorAll('button,[role="button"]')].filter(visible)){
    const label=el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent).join(' ');
    const match=norm(label).match(/^open cart with items\s+(\d+)$/i);
    if(match)counts.push(Number(match[1]));
  }
  const before=counts.length && counts.every(n=>n===counts[0])?counts[0]:null;
  const ack = [...document.querySelectorAll('[role="dialog"],[role="status"],[role="alert"]')].filter(visible)
    .some(el => /added to (?:your )?(?:shopping )?cart/i.test(el.innerText) && norm(el.innerText).includes(title));
  if (ack) return {state:'already_added'};
  if(action==='repeat-base-add' && (!base || before!==0)) return {state:'review_cart'};
  if (action !== 'add' && action!=='repeat-base-add') return {state:'ready', before};
  buttons[0].click();
  return {state:'clicked', before};
}

// DOM mutations only wake the worker. The worker rechecks the same armed
// document before any cart action. Alarms independently handle full refreshes.
export function observeOffer(key, enable=true) {
  const slot='__sonyProOfferObserver';
  const previous=globalThis[slot];
  if (!enable) {if (previous?.key===key) previous.stop();return;}
  if (previous?.key===key) return;
  previous?.stop();
  let timer;
  const hero='producthero-info,producthero-mobile-price';
  const observer=new MutationObserver(records=>{
    if (timer || !records.some(r=>r.target.parentElement?.closest(hero) || r.target.closest?.(hero) ||
      [...r.addedNodes].some(n=>n.matches?.(hero)||n.querySelector?.(hero)))) return;
    timer=setTimeout(()=>{
      timer=undefined;
      chrome.runtime.sendMessage({type:'offer-changed',key}).catch(stop);
    },100);
  });
  function stop() {
    clearTimeout(timer);observer.disconnect();window.removeEventListener('pagehide',stop);
    if(globalThis[slot]?.key===key) delete globalThis[slot];
  }
  globalThis[slot]={key,stop};
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,
    attributeFilter:['class','style','hidden','disabled','aria-disabled','data-product-code']});
  window.addEventListener('pagehide',stop,{once:true});
}

export function cartConfirmation(before, model='pro') {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const item=model==='base'?/PlayStation®?\s*5 Console\s*[-–]\s*1 TB/i:/PlayStation®?\s*5 Pro Console/i;
  const label=el=>(el.getAttribute('aria-label')||el.innerText||'').trim();
  // The open drawer replaces the count icon. Scope item and quantity evidence
  // to the panel containing both of Sony's cart controls.
  for(const close of [...document.querySelectorAll('button,[role="button"]')].filter(el=>visible(el)&&/^close cart$/i.test(label(el)))){
    for(let panel=close.parentElement;panel && panel!==document.body && !panel.querySelector('h1');panel=panel.parentElement){
      const edit=[...panel.querySelectorAll('button,[role="button"],a')].some(el=>visible(el)&&/^edit and checkout$/i.test(label(el)));
      if(!edit)continue;
      const copy=(panel.innerText||'').replace(/\s+/g,' ');
      const match=copy.match(item);
      if(match && copy.slice(match.index+match[0].length,match.index+match[0].length+60).match(/\bqty\s*:\s*(\d+)\b/i)?.[1]==='1') return true;
    }
  }
  const counts=[...document.querySelectorAll('.js-mini-cart-count')].filter(visible)
    .map(el=>el.textContent.trim()).filter(s=>/^\d+$/.test(s)).map(Number);
  for(const el of [...document.querySelectorAll('button,[role="button"]')].filter(visible)){
    const match=(el.getAttribute('aria-label')||'').trim().match(/^open cart with items\s+(\d+)$/i);
    if(match)counts.push(Number(match[1]));
  }
  return (before !== null && counts.length>0 && counts.every(n=>n===before+1)) ||
    [...document.querySelectorAll('[role="dialog"],[role="status"],[role="alert"]')].filter(visible)
      .some(el => /added to (?:your )?(?:shopping )?cart/i.test(el.innerText) &&
        item.test(el.innerText));
}
