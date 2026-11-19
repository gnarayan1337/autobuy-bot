export const TARGET_ORDER = Object.freeze({
  tcin: '93620188', name: 'PlayStation 5 Pro Console', zip: '75013', maxCents: 110000,
});
export const TARGET_PRO_URL='https://www.target.com/p/playstation-5-pro-console/-/A-93620188';

export function isProListing(url) {
  try {
    const u=new URL(url);
    return u.origin==='https://www.target.com' && /^\/p\/(?:[^/]+\/)?-\/A-93620188\/?$/.test(u.pathname);
  } catch {return false;}
}

/**
 * Runs as a serialized function in one Target document. Keep DOM helpers inside.
 * The cart read produces item proof. Order review adds the total in cents and
 * the displayed card identity. The worker supplies that proof on each commit.
 * Only fill-cvv and the one-time base fill accept a code. Results contain
 * status and evidence, never the code. Only the Pro flow can click Confirm.
 */
export function checkoutPage(stage, order, proof = null, commit = false, securityCode = null) {
  const wait = reason => ({state: 'wait', reason});
  const stop = reason => ({state: 'review', reason});
  const baseRehearsal=order?.tcin==='94961316' && order.name==='PlayStation 5 Console - Digital Edition';
  const baseLiveTest=stage==='base-try-place' || stage==='base-fill-stop';
  if (order?.tcin!=='93620188' && !baseRehearsal) return stop('Unexpected checkout item.');
  if (baseLiveTest) {
    if (!baseRehearsal || !proof?.cardTag || !Number.isSafeInteger(proof.totalCents) || proof.totalCents<=0 || proof.totalCents>64949)
      return stop('This one-time base test needs the reviewed saved card and a total within $649.49.');
    stage=stage==='base-try-place'?'checkout':'fill-cvv';
  } else if (baseRehearsal && ((commit && !['drawer','cart'].includes(stage)) || ['fill-cvv','confirm-cvv'].includes(stage)))
    return stop('Base rehearsal ends before any live payment or order submission.');
  const visible = el => el.checkVisibility({checkVisibilityCSS: true, checkOpacity: true}) && el.getClientRects().length > 0;
  const all = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const norm = text => (text || '').replace(/\s+/g, ' ').trim();
  const text = el => norm(el.innerText ?? el.textContent);
  const name = el => norm(el.getAttribute('aria-label') || el.innerText || el.querySelector('img')?.alt);
  const controls = (root, pattern) => all(root, 'a[href],button,[role="button"]').filter(el => pattern.test(name(el)) || pattern.test(text(el)));
  const enabled = el => !el.matches(':disabled') && !el.closest('[aria-disabled="true"],[inert]') && getComputedStyle(el).pointerEvents !== 'none';
  const exactTitle = title => norm(title).toLowerCase() === order.name.toLowerCase();
  const path = location.pathname.replace(/\/$/, '');
  const isCart = path === '/cart';
  const isCheckout = /^\/(?:checkout(?:\/.*)?|co-(?:review|checkout|delivery|payment))$/.test(path);
  if (location.origin !== 'https://www.target.com') return stop('The tab left Target.');
  if (!document.body) return wait('Waiting for Target to load.');
  const pageText = document.body.innerText || '';
  const isVerificationTitle = /^\s*(?:(?:quick|human) verification|bot (?:challenge|verification(?: challenge)?))\s*$/im;
  if (all(document,'iframe#px-captcha-modal').length || isVerificationTitle.test(pageText) || all(document,'iframe,[role="alert"],[role="dialog"]').some(panel =>
    [panel.title,panel.getAttribute('aria-label'),panel.contentDocument?.title].some(title=>isVerificationTitle.test(norm(title))) ||
    isVerificationTitle.test(panel.contentDocument?.body?.innerText || '')))
    return stop('Complete Quick verification in the open Target tab and review your checkout.');
  const body = norm(pageText);
  if (/verify (?:that )?you are human|access denied|unusual traffic|press (?:and|&) hold to (?:verify|confirm)|waiting room|too many requests/i.test(body) ||
      all(document, 'input[autocomplete="one-time-code"],iframe[title*="challenge" i],iframe[title*="human verification" i],iframe[src*="captcha" i]').length)
    return stop('Target requires verification. Review the tab.');

  const main = document.querySelector('main,[role="main"]') || document.body;
  const unique = values => Array.from(new Set(values));
  const amounts = /\$\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d.])/g;
  const toCents = amount => Number(amount.replace(/\D/g, ''));
  const itemCounts = value => Array.from(value.matchAll(/\b(\d+)\s+items?\b/gi), m => Number(m[1]));
  function countsIn(root) {
    return unique([root,...all(root,'span,p,strong,b,small,div')].flatMap(el => itemCounts(text(el))));
  }
  function enclosing(el, predicate) {
    for (let node = el; node && node !== document.body && node !== main; node = node.parentElement) {
      if (predicate(node)) return node;
    }
    return null;
  }
  // Real Target product-image IDs survive different thumbnail sizes and query strings.
  function imageId(img) {
    try {
      const url = new URL(img.currentSrc || img.src, location.href);
      if (url.origin === 'https://target.scene7.com')
        return url.pathname.match(/^\/is\/image\/Target\/(GUEST_[a-f0-9-]{36}|\d{8})(?:$|\/)/i)?.[1] || null;
    } catch { /* A placeholder can render before the product image. */ }
    return null;
  }
  function itemId(link) {
    const url = new URL(link.href, location.href);
    const id = url.pathname.match(/^\/p\/(?:[^/]+\/)?-\/A-(\d+)\/?$/)?.[1];
    if (!id) return null;
    return url.origin === location.origin && (!url.searchParams.has('preselect') || url.searchParams.get('preselect') === id) ? id : 'other';
  }
  function heading(label) {
    const found = all(main, 'h1,h2,h3,h4,[role="heading"],[data-test],strong,span')
      .filter(el => label.test(text(el)));
    const leaves = found.filter(el => !found.some(child => child !== el && el.contains(child)));
    return leaves.length === 1 ? leaves[0] : null;
  }
  function linkCanStayInTab(el, allowedPath) {
    if (!el.matches('a[href]')) return true;
    const u = new URL(el.href);
    return u.origin === location.origin && allowedPath.test(u.pathname) && (!el.target || el.target === '_self');
  }
  function act(button, details = {}) {
    if (!enabled(button)) return wait('Waiting for Target to enable the next button.');
    if (commit) button.click();
    return {state: commit ? 'clicked' : 'ready', ...details};
  }
  if (stage === 'drawer') {
    if (!path.endsWith('/-/A-' + order.tcin) || !/^\/p\//.test(path)) return stop('The Pro listing changed after Add.');
    const buttons = controls(document, /^view cart (?:&|and) check\s?out$/i);
    const btn = buttons.length === 1 ? buttons[0] : null;
    if (btn && enabled(btn) && linkCanStayInTab(btn, /^\/cart\/?$/)) return act(btn);
    // The Add was already acknowledged. Use Target's cart when its drawer has closed.
    return {state: 'use-cart-url'};
  }
  const afterOrder = ['receipt','fill-cvv','confirm-cvv'].includes(stage);
  const cardPattern=/\b(Mastercard|Visa|Amex|American Express|Discover|(?:Target )?Circle Card|RedCard)\s*(?:card\s+)?(?:ending (?:in|with)\s*[*•·x]*\s*|[*•·x]+\s*)(\d{4})\b/i;
  function cardTag(el) {
    const match=text(el).match(cardPattern);
    return match ? match[1].toLowerCase()+':'+match[2] : null;
  }
  let cvvDrawer=null, field=null, confirm=null;
  if (afterOrder) {
    if (!isCheckout && !/^\/(?:co-(?:confirmation|thank-?you)|order-?confirmation)(?:\/|$)/i.test(path))
      return stop('The order result is unknown. Check Target order history.');
    if (/\b(?:thank(?:s| you) for (?:your order|shopping)|(?:your )?order (?:is confirmed|confirmed|has been placed|placed))\b/i.test(body) &&
        /\border\s*(?:number|no\.?|#)\s*[:#]?\s*[A-Z]*\d[\d-]{3,}/i.test(body)) return {state: 'confirmed'};
    const titles=all(document,'h1,h2,h3,h4,[role="heading"]').filter(el=>/^confirm cvv$/i.test(text(el)));
    if (!titles.length) return wait('Waiting for Target to confirm the order.');
    if (!isCheckout || titles.length!==1) return stop('Cannot verify the Target card confirmation.');
    cvvDrawer=enclosing(titles[0],el=>!!cardTag(el) && controls(el,/^confirm$/i).length===1 &&
      (el.matches('dialog,[role="dialog"],[aria-modal="true"],aside') || controls(el,/^pay another way instead$/i).length===1));
    if (!cvvDrawer || !proof?.cardTag || cardTag(cvvDrawer)!==proof.cardTag)
      return stop('The card confirmation does not match the reviewed saved card.');
    const fields=all(cvvDrawer,'input').filter(el=>el.autocomplete==='cc-csc' || /\b(?:cvv|cvc|card security code)\b/i.test(
      [el.placeholder,el.getAttribute('aria-label'),el.name,el.id,...Array.from(el.labels||[],text)].join(' ')));
    if(fields.length!==1 || fields[0].readOnly || fields[0].disabled || !['text','password','tel','number'].includes(fields[0].type))
      return stop('The card-code field is unavailable or hosted outside the Target document.');
    field=fields[0]; confirm=controls(cvvDrawer,/^confirm$/i)[0];
    const destinations=[field.form?.action,confirm.form?.action,confirm.getAttribute('formaction')].filter(Boolean);
    if (confirm.tagName!=='BUTTON' || destinations.some(value=>new URL(value,location.href).origin!==location.origin))
      return stop('Cannot verify the destination of the card confirmation.');
    if (/\b(?:invalid|incorrect|try again|does not match)\b/i.test(text(cvvDrawer))) return stop('Target rejected card verification. Review the order.');
  }
  if (all(document,'input[type="password"],input[autocomplete="cc-csc"]').some(el=>el!==field))
    return stop('Target requires sign-in or separate payment verification.');
  if (all(document,'dialog[open],[aria-modal="true"],[role="dialog"]').some(el=>!cvvDrawer || (!el.contains(cvvDrawer) && !cvvDrawer.contains(el))))
    return stop('A dialog is open. Review the Target tab.');
  if (stage === 'cart') {
    if (!isCart) return wait('Waiting for the cart.');
    const ctas = controls(main, /^(?:check\s?out|I.m ready to check out)$/i);
    const saves = controls(main, /^save (?:for later\b.*|.+ for later)$/i);
    if (saves.length > 1) return stop('More than one active cart line. Review the cart.');
    if (ctas.length !== 1 || saves.length !== 1) return wait('Waiting for one active cart line and Check out.');
    const countBox = enclosing(ctas[0], el => text(el).length < 700 && countsIn(el).length > 0);
    if (!countBox) return wait('Waiting for the cart item count.');
    if (countsIn(countBox).some(n => n !== 1)) return stop('Only one cart item is authorized.');
    if (!linkCanStayInTab(ctas[0], /^\/(?:checkout(?:\/|$)|co-(?:review|checkout|delivery|payment)\/?$)/))
      return stop('Unexpected checkout destination.');

    // "Save for later" belongs to an active line. A Pro under "Saved for later"
    // or "Recently viewed" must never establish the identity of that line.
    const productLinks = el => all(el, 'a[href*="/A-"]').filter(a => itemId(a));
    const row = enclosing(saves[0], el => productLinks(el).length > 0 &&
      (el.querySelector('input[type="number"],[role="spinbutton"],select,[aria-label*="quantity" i]') ||
       controls(el,/increase|increment|add (?:one|1)\b|^\+$|^plus$/i).length || /\b(?:qty|quantity)\s*:?\s*\d+/i.test(text(el))));
    if (!row || /(?:saved for later|recently viewed|frequently (?:bought|also added))/i.test(text(row)))
      return wait('Cannot isolate the active cart item.');
    const links = productLinks(row);
    if (links.some(a => itemId(a) !== order.tcin)) return stop('The active cart item is not the authorized PS5 Pro.');
    if (!links.some(a => [name(a), text(a), a.querySelector('img')?.alt].some(exactTitle)))
      return wait('Waiting for the Pro product name on the active line.');
    const lineText = text(row);
    const quantityControls = all(row, 'input[type="number"],input[type="text"],[role="spinbutton"],select').filter(el =>
      el.matches('input[type="number"],[role="spinbutton"]') || /qty|quantity/i.test([name(el), el.id, el.getAttribute('name')].join(' ')));
    const quantities = quantityControls.map(el => Number(el.getAttribute('aria-valuenow') || el.value));
    quantities.push(...Array.from(lineText.matchAll(/\b(?:qty|quantity)\s*[: ]\s*(\d+)\b/gi), m => Number(m[1])));
    for (const up of controls(row, /increase|increment|add (?:one|1)\b|^\+$|^plus$/i)) {
      const stepper = enclosing(up, el => row.contains(el) && controls(el, /decrease|decrement|remove one|^[-−–]$|^minus$/i).length > 0);
      if (!stepper) continue;
      // The live cart's native select has no quantity label. Its selected option
      // sits between the decrement and increment controls, alongside a text copy.
      for(const select of stepper.querySelectorAll('select')) {
        const option=select.selectedOptions[0];
        const shown=norm(option?.textContent);
        if(/^\d+$/.test(shown)) quantities.push(Number(shown));
      }
      for(const combo of all(stepper,'[role="combobox"],button[aria-haspopup="listbox"]')) {
        if(/^\d+$/.test(text(combo))) quantities.push(Number(text(combo)));
      }
      const digits = text(stepper).match(/^(?:[-−–]\s*)?(\d+)(?:\s*\+)?$/);
      if (digits) quantities.push(Number(digits[1]));
    }
    if (quantities.some(n => n !== 1)) return stop('The cart quantity is not one.');
    if (!quantities.length) return wait('Waiting for the active Pro quantity.');
    const group = enclosing(row, el => {
      const s = text(el);
      return /\bshipping\s+to\s+\d{5}\b/i.test(s) && !/saved for later|recently viewed/i.test(s);
    });
    const destinations = group ? Array.from(text(group).matchAll(/\bshipping\s+to\s+(\d{5})\b/ig), m => m[1]) : [];
    if (destinations.some(z => z !== order.zip)) return stop('The shipping ZIP changed.');
    const shippingRoot = group || row;
    const selected = Array.from(shippingRoot.querySelectorAll('input[type="radio"]:checked,[role="radio"][aria-checked="true"]'));
    const radioLabels = selected.map(el => norm([name(el), ...Array.from(el.labels || [], text),
      ...(el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText)].join(' '))).filter(Boolean);
    if (radioLabels.some(label => !/\bshipping\b/i.test(label) || /pickup|drive up|same.day delivery/i.test(label))) return stop('Shipping is not the selected cart option.');
    if (!radioLabels.length && !destinations.length) return wait('Waiting for the cart shipping method.');
    if (/\b(?:out of stock|sold out|no longer available)\b/i.test(lineText)) return stop('The Pro left stock in the cart.');
    if (shippingRoot.querySelector('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')) return stop('A cart extra is selected.');
    if (/\bsold (?:and shipped )?by\s+(?!target\b)/i.test(lineText)) return stop('Review the seller on the cart line.');
    const images = all(row, 'img').filter(img => links.some(link => link.contains(img)) || exactTitle(img.alt)).map(imageId).filter(Boolean);
    if (proof?.primaryImage) images.push(proof.primaryImage);
    return act(ctas[0], {proof: {tcin: order.tcin, images: unique(images)}});
  }
  if ((stage !== 'checkout' && !cvvDrawer) || !isCheckout || proof?.tcin !== order.tcin) return stop('The verified cart or Target checkout is missing.');
  const place = controls(main, /^place (?:your )?order$/i);
  const summaryHeading = heading(/^order summary$/i);
  const cartHeading = heading(/^cart$/i);
  if (place.length !== 1 || !place[0].matches('button,[role="button"]:not(a)') || !summaryHeading || !cartHeading)
    return wait('Waiting for the cart, order summary and Place your order.');
  if(stage==='checkout' && (!enabled(place[0]) || /^\/checkout\/(?:payment|shipping)\/?$/.test(path)))
    return wait('Waiting for final order review after the checkout edit.');
  const summary = enclosing(summaryHeading, el => /\bsubtotal\s*\(\s*\d+\s+items?\s*\)/i.test(text(el)) && /\btotal\s*\$\s*[\d,]+\.\d{2}\b/i.test(text(el)) && !el.contains(cartHeading));
  if (!summary) return wait('Waiting for the item count and final total.');
  const counts = itemCounts(text(summary));
  if (!counts.length || counts.some(n => n !== 1)) return stop('The checkout summary must contain exactly one item.');
  function amountAfterLabel(pattern) {
    const labels = all(summary, 'h1,h2,h3,h4,[role="heading"],span,strong,b,p,div,dt,th,td').filter(el => pattern.test(text(el)));
    const totals = [];
    for (const label of labels) {
      const line = enclosing(label, el => summary.contains(el) && (text(el).match(amounts) || []).length > 0);
      if (!line) continue;
      const value = text(line).slice(text(label).length).trim();
      if (text(line).startsWith(text(label)) && /^\$\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/.test(value)) totals.push(toCents(value));
    }
    return unique(totals);
  }
  const totals = amountAfterLabel(/^(?:order )?total$/i);
  if (totals.length !== 1 || totals[0] <= 0 || !Number.isSafeInteger(totals[0])) return wait('Waiting for one exact order total.');
  if (totals[0] > order.maxCents) return stop('The final total exceeds the authorized limit.');
  const picturedItem=img=>norm(img.getAttribute('aria-label')||img.alt).match(/^(.+?)\s+quantity\s*:?\s*(\d+)$/i);
  const cart = enclosing(cartHeading, el => !el.contains(summaryHeading) && itemCounts(text(el)).length > 0 &&
    all(el, 'a[href*="/A-"],img,[role="img"]').some(node => node.tagName==='A'?itemId(node):picturedItem(node)||imageId(node)));
  if (!cart) return wait('Waiting for identifiable items in the checkout Cart section.');
  const cartText = text(cart);
  if (itemCounts(cartText).some(n => n !== 1)) return stop('The checkout cart quantity changed.');
  const itemIds = unique(all(cart, 'a[href*="/A-"]').map(itemId).filter(Boolean));
  const imageIds = unique(all(cart, 'img').map(imageId).filter(Boolean));
  if (itemIds.some(id => id !== order.tcin) || (imageIds.length && proof.images.length && imageIds.some(id => !proof.images.includes(id))))
    return stop('The checkout item differs from the verified Pro.');
  const pictured=all(cart,'img,[role="img"]').map(picturedItem).filter(Boolean);
  if (pictured.some(m=>!exactTitle(m[1]) || Number(m[2])!==1)) return stop('The checkout item name or quantity differs from the authorized Pro.');
  if (!itemIds.includes(order.tcin) && pictured.length!==1 && !(imageIds.length === 1 && proof.images.includes(imageIds[0])))
    return wait('Cannot match the checkout item to the Pro in the active cart.');
  const promise = all(cart,'p,span,div,li,h2,h3,h4').some(el => {
    if (el.closest('button,a,aside,[role="button"]')) return false;
    const wording=text(el);
    return wording.length<160 && !/pick\s?up|drive up|switch|instead|same.day/i.test(wording) &&
      /(?:\b(?:get it (?:by|on|today|tomorrow)|arrives? (?:by|on|today|tomorrow|\w{3},)|ships? to)\b|^shipping$)/i.test(wording);
  });
  if (!promise ||
      /\b(?:ready for (?:order )?pickup|order pickup at|drive up at|same.day delivery (?:at|to)|sold out|out of stock|no longer available)\b/i.test(cartText) ||
      !/\bshipping\s+(?:free|\$\s*[\d,]+\.\d{2})\b/i.test(text(summary)))
    return wait('Waiting for a shipping order and its shipping charge.');
  const addressHeading = heading(/^(?:shipping address|address|ship to)$/i);
  const address = addressHeading && enclosing(addressHeading, el => !el.contains(summaryHeading) && /(?:,\s*|\s)[A-Z]{2}(?:,|\s)+\d{5}\b/.test(text(el)));
  if (!address) return wait('Waiting for the saved shipping address.');
  const zips = Array.from(text(address).matchAll(/(?:,\s*|\s)[A-Z]{2}(?:,|\s)+(\d{5})\b/g), m => m[1]);
  if (zips.some(z => z !== order.zip)) return stop('The checkout shipping ZIP changed.');
  // Under the final Total, Target displays the amount to charge and the
  // masked saved card. Card marketing or an unselected wallet option is insufficient.
  const paymentScope=enclosing(summaryHeading,el=>!el.contains(cartHeading) && !!cardTag(el));
  const paymentLabels=paymentScope?all(paymentScope,'p,span,div,strong,small').filter(el=>
    !el.closest('button,a,[role="radio"],[role="option"]') && cardTag(el) && text(el).length<100):[];
  const paid=unique(paymentLabels.filter(label=>enclosing(label,el=>{
    if (!paymentScope.contains(el) || text(el).length>140) return false;
    const charges=text(el).match(amounts) || [];
    return charges.length===1 && toCents(charges[0])===totals[0];
  })).map(cardTag));
  if (paid.length!==1) return wait('Waiting for one saved card and its matching charge.');
  if (proof.cardTag && proof.cardTag!==paid[0]) return stop('The saved payment method changed.');
  if (/\b(?:Allstate|protection plan|subscription|membership)\b/i.test(cartText + ' ' + text(summary))) return stop('Checkout contains an extra product or service.');
  if (proof.totalCents != null && proof.totalCents !== totals[0]) return stop('The total changed just before submission.');
  if (cvvDrawer) {
    if (!Number.isSafeInteger(proof.totalCents) || !proof.cardTag) return stop('The original order review is missing.');
    if(stage==='receipt') return {state:'needs-code',cardTag:paid[0]};
    if(stage==='fill-cvv' && commit) {
      if (!/^\d{3,4}$/.test(securityCode||'') || field.value || !enabled(field)) return stop('The card-code field is not ready for a one-time entry.');
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(field,securityCode);
      field.dispatchEvent(new Event('input',{bubbles:true}));
      field.dispatchEvent(new Event('change',{bubbles:true}));
      if(field.value!==securityCode) return stop('Target did not accept the card-code entry.');
      if(baseLiveTest) return {state:'filled',masked:field.type==='password' || getComputedStyle(field).webkitTextSecurity==='disc'};
      globalThis.__targetProCodeInput=field;
      field.addEventListener('input',()=>{delete globalThis.__targetProCodeInput;},{once:true});
      return {state:'filled'};
    }
    if(stage==='confirm-cvv' && commit && globalThis.__targetProCodeInput===field && /^\d{3,4}$/.test(field.value)) {
      if(!enabled(confirm)) return wait('Waiting for Target to enable card confirmation.');
      delete globalThis.__targetProCodeInput;
      return act(confirm);
    }
    return stop('Card confirmation changed. Review the order.');
  }
  return act(place[0], {totalCents: totals[0],cardTag:paid[0]});
}
