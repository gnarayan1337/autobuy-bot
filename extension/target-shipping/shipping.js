// Serialized into the isolated world of the single user-selected tab. An armed
// watch key installs one observer. Passing null performs a one-shot action.
// Observer messages wake the worker, which rereads the live control before Add.
export function observeShipping(key, model='pro', action='observe') {
  const slot = '__ps5ProTargetShipping';
  const rehearsal = model === 'base-rehearsal' && !key;
  const base = model === 'base' || rehearsal;
  const watching = !base && !!key && action==='observe';
  const previous = globalThis[slot];
  if (watching && previous?.key === key) return previous.inspect(true);
  if (watching) previous?.stop();

  let lastDismissed=null;
  function inspect(workerRead=false) {
    let label, noticeReady=false;
    const result = (state, reason) => ({state, reason, ...(label?{label}:{}), ...(noticeReady?{noticeReady:true}:{}), at:new Date().toISOString()});
    const pathMatch=location.pathname.match(/^\/p\/(?:[^/]+\/)?-\/A-(\d+)\/?$/);
    if (location.origin !== 'https://www.target.com' || pathMatch?.[1] !== (base?'94961316':'93620188')) {
      return result('away', 'The tab is not the expected console listing.');
    }
    const visible = el => el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) && el.getClientRects().length > 0;
    const norm = s => (s || '').replace(/\s+/g,' ').trim();
    const pageText = document.body?.innerText || '';
    if ([...document.querySelectorAll('iframe#px-captcha-modal')].some(visible)) {
      return result('verification','Target verification overlay is visible. Holding shipping actions.');
    }
    const isVerificationTitle = /^\s*(?:(?:quick|human) verification|bot (?:challenge|verification(?: challenge)?))\s*$/im;
    const verificationPanel = [...document.querySelectorAll('iframe,[role="alert"],[role="dialog"]')].filter(visible).some(panel =>
      [panel.title, panel.getAttribute('aria-label'), panel.contentDocument?.title].some(title => isVerificationTitle.test(norm(title))) ||
      isVerificationTitle.test(panel.contentDocument?.body?.innerText || ''));
    if (isVerificationTitle.test(pageText) || verificationPanel) {
      return result('attention','Complete Quick verification in the open Target tab, then rearm the watch.');
    }
    const title = [...document.querySelectorAll('h1')].filter(visible);
    const obstacles = [...document.querySelectorAll('h1,h2,[role="dialog"],[role="alert"],main > p')].filter(visible);
    if (/too many requests|access denied|verify (?:that )?you are human|press (?:and|&) hold to (?:verify|confirm)|temporarily blocked/i.test(pageText) ||
        obstacles.some(el => /press (?:and|&) hold|waiting room|human verification/i.test(el.innerText)) ||
        [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],iframe[title*="challenge" i],iframe[title*="human verification" i]')].some(visible)) {
      return result('attention', 'Target is requesting attention. Review the tab.');
    }
    if (title.length !== 1 || norm(title[0].innerText) !== (base?'PlayStation 5 Console - Digital Edition':'PlayStation 5 Pro Console')) {
      return result('unknown', 'Waiting for the expected product heading.');
    }
    // A mutation only wakes the worker. Only its armed read can perform the
    // dismissal, after the product and verification checks above.
    if (watching) {
      const matches=[...document.querySelectorAll('#notice > a[role="button"][aria-label="Dismiss notice"]:not([href])')].filter(el=>
        norm(el.innerText)==='Dismiss' && visible(el) && !el.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') &&
        getComputedStyle(el).pointerEvents!=='none');
      const dismiss=matches.length===1?matches[0]:null;
      if (!dismiss) lastDismissed=null;
      else if (dismiss!==lastDismissed) {
        if (workerRead) {
          lastDismissed=dismiss;
          dismiss.click();
          if (!dismiss.isConnected || !visible(dismiss)) lastDismissed=null;
        } else noticeReady=true;
      }
    }
    const tiles = [...document.querySelectorAll('[aria-label="Fulfillment" i] button#SHIPPING, [data-test="module-product-detail-fulfillment-v1"] button#SHIPPING')].filter(visible);
    if (tiles.length !== 1) return result('unknown', 'Waiting for one identifiable Shipping tile.');
    const tile = tiles[0];
    label = norm(tile.getAttribute('aria-label') || tile.innerText).slice(0,120);
    const words = norm((tile.getAttribute('aria-label') || '') + ' ' + tile.innerText);
    if (/\bloading\b/i.test(words)) return result('unknown', 'The Shipping tile is loading.');
    const states = [...tile.classList].map(c => /^styles_(?:active|notActive)And(Available|Unavailable)FulfillmentCell__/.exec(c)?.[1]);
    if (states.includes('Unavailable') || /\b(not available|unavailable|out of stock|sold out|cannot ship|cannot be shipped|not eligible for shipping|0 left)\b/i.test(words)) {
      return result('unavailable', 'Target marks Shipping unavailable.');
    }
    if (tile.matches(':disabled') || tile.getAttribute('aria-disabled') === 'true' ||
        /\b(not|cannot|loading|when available|notify|pre[- ]?order|back[- ]?order|waitlist|coming soon)\b/i.test(words)) {
      return result('unknown', 'No confirmed current shipping offer.');
    }
    if (states.includes('Available') || /\b(arrives? (?:by|on|in|tomorrow|today)|get it (?:by|on|today|tomorrow)|ships? (?:by|in \d+|today|tomorrow)|available (?:for shipping|to ship)|ready to ship|in stock|(?:only\s*)?[1-9]\d*\s+(?:(?:items?|units?)\s+)?(?:left|remaining))\b/i.test(words)) {
      if (['prepare-cart','inspect-cart','add-one'].includes(action)) {
        if (base && !rehearsal) return result('attention','The base console is a read-only comparison.');
        const signedIn = [...document.querySelectorAll('a[href*="/account"]')].some(el =>
          visible(el) && /^hi,\s*\S/i.test(norm([el.getAttribute('aria-label'),el.innerText].filter(Boolean).join(' '))));
        if (!signedIn) return result('attention','Target sign-in is unverified. Review the tab.');
        const selected = [...tile.classList].some(c=>/^styles_activeAndAvailableFulfillmentCell__/.test(c)) ||
          /(?:^|,)\s*selected\b/i.test(tile.getAttribute('aria-label')||'') ||
          ['aria-pressed','aria-checked','aria-selected'].some(k=>tile.getAttribute(k)==='true');
        if (!selected) {
          if (action==='prepare-cart') {tile.click();return result('selecting','Selecting Shipping.');}
          return result('attention','Shipping is not selected.');
        }
        const root = document.querySelector('#above-the-fold-information') || document;
        const name = el => norm(el.getAttribute('aria-label') ||
          (el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim() || el.innerText);
        const addName=base?/^add to cart(?: for)? PlayStation 5 Console - Digital Edition$/i:/^add to cart(?: for)? PlayStation 5 Pro Console$/i;
        const controls = [...root.querySelectorAll('button')].filter(el => visible(el) &&
          (addName.test(name(el)) ||
           (/^add to cart$/i.test(name(el)) && el.closest('[data-test="module-product-detail-add-to-cart"]'))));
        if (controls.length!==1) return result('attention','Cannot identify a unique Pro Add button.');
        const button=controls[0], bounds=button.getBoundingClientRect();
        if (button.matches(':disabled') || button.closest('[inert],[aria-disabled="true"]') ||
            bounds.width<=0 || bounds.height<=0 || getComputedStyle(button).pointerEvents==='none')
          return result('attention','The Pro Add button is not enabled.');
        if ([...root.querySelectorAll('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')].some(visible))
          return result('attention','An optional service is selected. Review the listing.');
        const qty=[...root.querySelectorAll('select,input[type="number"],[role="spinbutton"]')].filter(el=>visible(el) &&
          (/qty|quantity/i.test([el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('data-test')].join(' ')) || el.type==='number'));
        if (qty.some(el=>String(el.value??el.getAttribute('aria-valuenow')).trim()!=='1'))
          return result('attention','Quantity is not confirmed as one.');
        const countText=[...document.querySelectorAll('a[href*="/cart"]')].filter(visible).map(name).join(' ');
        const count=countText.match(/\bcart\s*[:,]?\s*(\d+)\s+items?\b/i);
        const before=count?Number(count[1]):null;
        if(rehearsal && before!==0) return result('attention','The base rehearsal requires an empty active cart.');
        if (action==='add-one') {
          let primaryImage=null;
          try {
            const image=new URL(document.querySelector('meta[property="og:image"]').content);
            if(image.origin==='https://target.scene7.com') primaryImage=image.pathname.match(/^\/is\/image\/Target\/(GUEST_[a-f0-9-]{36}|\d{8})\/?$/i)?.[1]||null;
          } catch { /* The exact cart item can also supply its product image. */ }
          button.click();
          return {...result('clicked','Sent one Add click.'),before,primaryImage};
        }
        return {...result('ready','Shipping is selected and the Pro Add button is enabled.'),before};
      }
      return result('available', 'Target offers shipping for this console.');
    }
    return result('unknown', 'Shipping has no recognized availability signal.');
  }

  const first = inspect(watching);
  if (!watching) return first;
  let last = first.state, timer;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const next = inspect();
      if (next.state !== last || next.noticeReady) {
        last = next.state;
        chrome.runtime.sendMessage({kind:'reading', key, reading:next}).catch(stop);
      }
    }, 150);
  });
  function stop() {
    observer.disconnect(); clearTimeout(timer);
    window.removeEventListener('pagehide', stop);
    if (globalThis[slot]?.key === key) delete globalThis[slot];
  }
  globalThis[slot] = {key, inspect, stop};
  observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true,attributes:true,
    attributeFilter:['aria-label','aria-disabled','class','disabled','hidden','style','id']});
  window.addEventListener('pagehide', stop, {once:true});
  return first;
}

export function cartAcknowledgement(before,model='pro') {
  const visible=el=>el.getClientRects().length>0 && el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  const counts=[...document.querySelectorAll('a[href*="/cart"]')].filter(visible)
    .map(el=>(el.getAttribute('aria-label')||el.innerText).match(/\bcart\s*[:,]?\s*(\d+)\s+items?\b/i)?.[1]).filter(Boolean);
  if(before!==null && counts.length && counts.every(n=>Number(n)===before+1)) return 'count_increased';
  const dialogs=[...document.querySelectorAll('[role="dialog"],[role="status"],[role="alert"]')].filter(visible);
  const item=model==='base-rehearsal'?/PlayStation 5 Console - Digital Edition/i:/PlayStation 5 Pro Console/i;
  if(dialogs.some(el=>/added to (?:your )?cart/i.test(el.innerText) && item.test(el.innerText))) return 'item_acknowledged';
  // Some drawer layouts have an aside with no dialog role. The confirmation
  // heading, Pro and cart link belong together, above the recommendations.
  const cartLinks=[...document.querySelectorAll('a[href],button')].filter(el=>visible(el) &&
    /^view cart (?:&|and) check\s?out$/i.test((el.innerText||el.getAttribute('aria-label')||'').trim()));
  if(cartLinks.length===1) {
    for(let el=cartLinks[0].parentElement;el && el!==document.body;el=el.parentElement) {
      const copy=(el.innerText||'').split(/frequently also added|recently viewed|recommendations/i)[0];
      if (/added to (?:your )?cart/i.test(copy) && item.test(copy) &&
          !el.querySelector('h1')) return 'item_acknowledged';
    }
  }
  return null;
}

export function stopObserver(key) {
  if (globalThis.__ps5ProTargetShipping?.key === key) globalThis.__ps5ProTargetShipping.stop();
}
