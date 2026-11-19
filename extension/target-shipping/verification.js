// Serialized into the armed listing's ISOLATED world. Each call performs at
// most one click; the worker owns polling and cancellation. No delayed helper
// clicks remain in the page after Stop, Reset, or navigation.
export function advanceVerification(key) {
  const answer=(state,reason)=>({state,reason,at:new Date().toISOString()});
  const review=reason=>answer('attention',reason+' Complete verification in the Target tab, then rearm.');
  if (!key || location.origin!=='https://www.target.com' ||
      !/^\/p\/(?:[^/]+\/)?-\/A-93620188\/?$/.test(location.pathname))
    return review('Verification handling is limited to the armed Pro listing.');
  const visible=el=>el.isConnected && el.getClientRects().length>0 &&
    el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true});
  const enabled=el=>!el.matches(':disabled') && !el.closest('[aria-disabled="true"],[inert]') &&
    el.ownerDocument.defaultView.getComputedStyle(el).pointerEvents!=='none';
  // The live gray control has pointerup/mouseup handlers, but no click handler.
  // Send only one event family: compatibility mouse events would double-call
  // the same listener. These remain synthetic events; never claim acceptance.
  function pointer(button,type) {
    const view=button.ownerDocument.defaultView, rect=button.getBoundingClientRect();
    button.dispatchEvent(new view.PointerEvent(type,{
      bubbles:true,cancelable:true,composed:true,view,
      pointerType:'mouse',pointerId:1,isPrimary:true,button:0,
      buttons:type==='pointerdown'?1:0,
      clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,
    }));
  }
  const norm=s=>(s||'').replace(/\s+/g,' ').trim();
  const modals=[...document.querySelectorAll('iframe#px-captcha-modal')].filter(visible);
  if (!modals.length) return answer('absent','Verification overlay is no longer visible; rereading shipping.');
  if (modals.length!==1) return review('More than one verification overlay is visible.');
  const modal=modals[0];
  // Keep reservations across worker suspension and rearming in this document.
  // Weak keys avoid retaining removed overlays. New watch keys cannot replay an
  // already observed challenge, including one stopped between the two clicks.
  const slot='__ps5TargetVerification';
  const records=globalThis[slot]??(globalThis[slot]=new WeakMap());
  let record=records.get(modal);
  if (!record) {
    record={key,started:performance.now(),firstAt:null,secondAt:null};
    records.set(modal,record);
  }
  if (record.key!==key) return review('This verification overlay belongs to an earlier watch.');
  if (record.failed) return review(record.failed);
  const fail=reason=>{record.failed=reason;return review(reason);};
  if (performance.now()-record.started>45000) return fail('Verification did not clear within 45 seconds.');
  const wait=reason=>answer('verification',reason);
  try {
    const outer=modal.contentDocument;
    if (!outer?.body || !norm(outer.title)) return wait('Waiting for the verification document.');
    if (!/^(?:Human|Quick) verification$/i.test(norm(outer.title)))
      return fail('The verification document does not match the inspected Target prompt.');
    if (![...outer.querySelectorAll('.px-captcha-header')].some(el=>visible(el) && norm(el.innerText)==='Quick verification'))
      return wait('Waiting for the Quick verification heading.');
    const hosts=[...outer.querySelectorAll('#px-captcha')].filter(visible);
    if (hosts.length>1) return fail('More than one verification container is visible.');
    if (!hosts.length) return wait('Waiting for the verification container.');
    // Chrome exposes this API to extension content scripts without adding a
    // debugger permission or injecting into the page's JavaScript world.
    if (typeof chrome.dom?.openOrClosedShadowRoot!=='function')
      return fail('Chrome cannot inspect the verification container.');
    const root=chrome.dom.openOrClosedShadowRoot(hosts[0]);
    if (!root) return wait('Waiting for the verification controls.');
    const frames=[...root.querySelectorAll('iframe[title="Human verification challenge"]')].filter(visible);
    if (frames.length>1) return fail('More than one challenge frame is visible.');
    if (!frames.length) return wait('Waiting for a visible challenge frame.');
    const frame=frames[0], doc=frame.contentDocument;
    if (!doc?.body || !norm(doc.title)) return wait('Waiting for the readable challenge document.');
    if (norm(doc.title)!=='Human verification challenge') return fail('The challenge document changed.');
    if (record.firstAt!==null && (record.frame!==frame || record.doc!==doc))
      return fail('The challenge frame changed after the first click.');
    const controls=label=>[...doc.querySelectorAll(`[role="button"][aria-label="${label}"]`)].filter(visible);
    if (record.firstAt===null) {
      const buttons=controls('Accessible challenge');
      if (buttons.length>1) return fail('More than one accessibility control is visible.');
      if (buttons.length!==1 || !enabled(buttons[0])) return wait('Waiting for the enabled Accessible challenge control.');
      if (controls('Press again').length) return fail('This challenge was already started outside this watch.');
      const button=buttons[0];
      if (!button.matches('a') || button.hasAttribute('href')) return fail('The accessibility control changed.');
      record.frame=frame; record.doc=doc; record.firstButton=button;record.firstAt=performance.now();
      pointer(button,'pointerup');
      return wait('Accessibility input sent once. Waiting for Target to respond.');
    }
    if (record.secondAt!==null) return wait('Press again input sent once. Waiting for the verification overlay to clear.');
    const buttons=controls('Press again');
    record.acknowledged ||= buttons.length>0 || (record.firstButton?.isConnected &&
      (record.firstButton.getAttribute('aria-disabled')==='true' || record.firstButton.matches(':disabled')));
    if (!record.acknowledged) {
      if (performance.now()-record.firstAt>=5000)
        return fail('Target did not respond to the accessibility input. No retry was sent.');
      return wait('Accessibility input sent once. Waiting for Target to respond.');
    }
    if (performance.now()-record.firstAt<3000) return wait('Target responded. Waiting three seconds after the accessibility input.');
    if (buttons.length>1) return fail('More than one Press again control is visible.');
    if (buttons.length!==1 || !enabled(buttons[0])) return wait('Waiting for the enabled Press again control.');
    const button=buttons[0];
    if (!button.matches('div')) return fail('The Press again control changed.');
    record.secondAt=performance.now();
    pointer(button,'pointerdown');
    // A down handler can navigate or replace the controls synchronously.
    if (visible(modal) && visible(frame) && frame.contentDocument===doc && visible(button))
      pointer(button,'pointerup');
    return wait('Press again input sent once. Waiting for the verification overlay to clear.');
  } catch {
    // An uncertain click is never retried. DOM/frame failures need manual review.
    return fail('The verification document became inaccessible or a click result is uncertain.');
  }
}
