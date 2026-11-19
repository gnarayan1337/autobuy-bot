# Codebase guide

This repository has two retailers and three execution environments. A shell command can start either a Python HTTPS client or a Playwright browser. Chrome extensions run in a particular browser profile. For a CLI-only investigation, start with the Python parsers, the saved evidence and the offline checks below. The [README](README.md) covers operator setup and arming.

## Entry points and capabilities

| Entry point | Inventory source | Shopping actions |
| --- | --- | --- |
| `python3 -B src/shipping_http.py --model both` | One public Target listing GET per model | Read only. A loading Shipping tile gives `unknown`. |
| `python3 -B src/target_changes.py --model both --rounds 2 --interval 12` | Repeated public Target GETs with conditional headers when available | Read only. Compares each item with its previous response. |
| `python3 -B src/ps_direct.py check --model both` | Public Sony listing GET. Reads the primary product's structured Offer | Read only. The `watch` subcommand can notify on the Mac. |
| `node src/bot.mjs --once` | Target page in a dedicated persistent Chrome profile | One read. The distinct `--buy` mode can spend money through the page. |
| Target Chrome extension | Rendered Shipping tile on the armed tab. Optional page refresh | Alert, Add, or place one Pro order. Can handle a matching saved-card CVV drawer. |
| Sony Chrome extension | Scheduled reloads and rendered offer observations on the armed Pro tab | Alert and one signed-in Add attempt. Checkout remains with the shopper. |

Target's Pro is TCIN `93620188` and its base Digital Edition control is `94961316`. Sony's Pro SKU is `1000050805` and its base control is the **1 TB disc model**, SKU `1000049888`. Keep model IDs retailer-specific. Target's extension policy is one shipped Pro to ZIP `75013` with an all-in limit of `110000` integer cents. Its separately invoked base CVV test has a `64949`-cent ceiling and can place a real order.

## Public HTTP readers

- [src/storefront_html.py](src/storefront_html.py) builds the small HTML tree used by both Python readers. `Element.walk` traverses markup and `Element.text` omits templates and hidden content. It does not execute JavaScript. `NoRedirect` lets callers inspect a redirect as a response.
- [src/shipping_http.py](src/shipping_http.py) owns Target's URLs and model identities. `check` fetches HTML, `shipping_from_nodes` verifies the canonical URL, heading and unique Shipping control, and `catalog_from_nodes` reads item-specific catalog flags. The optional ZIP filters the evidence already in the response. The separate `--report` path reads a third-party publisher and labels the result with its source.
- [src/target_changes.py](src/target_changes.py) owns time-series polling. `fetch` handles validators and bounded gzip decoding. `snapshot` groups document hash, shipping evidence and catalog fields. `compare` checks the previous snapshot for the same TCIN. `poll` backs off after transient failures and stops on a declined or unrecognized page. `--rounds 0` runs continuously. `--log` sets the JSONL path.
- [src/ps_direct.py](src/ps_direct.py) owns Sony's public reader and Mac watcher. `offer` binds the canonical page, product name and SKU to the primary Offer. `check` handles conditional GETs and validates the response. `watch` owns the process lock, stop signal, backoff, timestamps and alerts. With `--add-to-cart` it signals a separate Chrome helper over stdin when the Pro becomes available.

### Interpreting CLI output

For the Target one-shot check, `shipping` is `available`, `unavailable` or `unknown`. A missing offer, loading tile or conflicting identity is unknown. `shippingEligible` is the catalog's ship-to-guest setting. Even `true` can accompany an unknown offer. Sony's one-shot check uses `stock` and `evidence`. Both one-shot commands return exit code 2 when a returned reading is unknown and 0 for known stock states, including unavailable.

The Target change monitor returns 0 if the bounded run completed with valid observations, even when availability stayed unknown. Look inside the JSONL. `baseline` starts a series, `not_modified` reuses a validated response, `shipping_data_changed` identifies a semantic change, and `other_page_bytes_changed` means only the full document hash changed among the compared fields. `catalog_changed`, `backoff` and `stopped` describe different outcomes. A change in shipping copy can still have an unknown meaning. Timestamps record when the client observed evidence.

### What the HTTP experiments established

On November 19, 2026, five public product responses per Target model returned HTTP 200. The base had displayed a shipping offer in Chrome, yet both models' raw HTML contained the same disabled `shipping - loading...` control. The category and shopper search samples also lacked a shipping decision tied to either item. More frequent reads of this placeholder cannot distinguish the two examples. The experiments did not establish a general lack of retailer inventory services. [Paired requests and follow-up](checks/target-https-shipping-2026-11-19.json)

For field-level comparisons, `python3 -B checks/audit_http_fields.py --base base.html --pro pro.html` operates on two existing product HTML files. It reports product fields and standardized offer markup with fingerprints for many text values. The earlier comparison, provenance, and 204-field audit are separate from the later time series. [Comparator](checks/audit_http_fields.py) · [Earlier comparison](checks/http-comparison-2026-11-18.json) · [Sources](checks/http-field-audit-sources.json) · [Field audit](checks/http-field-audit.json)

A browserless Target purchase implementation still needs a supported interface for retailer sign-in, shipping availability, carts, payment and order status. This repository contains no verified end-to-end Target HTTP implementation for those operations. For a new authorized provider, first demonstrate a **shipping-specific** read for the exact base and Pro items against contemporaneous shopper-visible controls. Include an unknown or declined case. Then validate cart writes, amount checks, idempotency and order reconciliation in the provider's test environment. A successful browser click or fixture run establishes only that execution path. Keep credentials, payment codes and private browser profiles out of fixtures and diagnostics.

## Target runtimes

### Node and Playwright

[package.json](package.json) maps the npm commands to entry points. Node 22+, Playwright and Chrome are used by the browser programs. The public Python checks use the standard library. [config.json](config.json) sets CLI defaults. An optional `config.local.json` overrides them. The extension uses its own `TARGET_ORDER` policy.

| Source | Responsibility |
| --- | --- |
| [src/bot.mjs](src/bot.mjs) | Parses the one selected mode, opens `.runtime/browser`, runs the polling loop and coordinates purchases. `--setup` establishes the dedicated profile, `--once` reads once, and the default loop monitors. `--http-check` is a browser-session diagnostic. `--buy` opts into live mutations. |
| [src/target.mjs](src/target.mjs) | Playwright operations for product and checkout snapshots, shipping selection, Add, order submit and confirmation. `observeUntilVerified` can suspend read-only observation for a visible challenge. |
| [src/safety.mjs](src/safety.mjs) | Pure predicates for exact item, shipping, total in cents, checkout evidence, retry delays and cadence. The optional session inventory matcher expects the configured TCIN and ZIP. A missed match is inconclusive. |
| [src/state.mjs](src/state.mjs) | Exclusive run lock and atomic state writes. A durable mutation phase survives restarts. Inspect the merchant cart and order history after an ambiguous result. |
| [src/diagnose.mjs](src/diagnose.mjs) | One read-only diagnostic in a fresh browser session. Results apply to that browser session. |

**Headless operation.** The CLI passes `config.headless` to `launchPersistentContext`. A visible setup and a later headless run can share the same dedicated profile after the first process closes. The working session lasts as long as the retailer accepts it. Interactive sign-in or human verification can interrupt it. The CLI's `buy` path submits through Playwright and waits for a receipt. The extension owns the CVV drawer implementation. Porting that capability to the CLI would require a deliberately integrated one-use payment flow and separate validation. To try a read-only headless run, complete visible `npm run setup`, close its dedicated browser and set `"headless": true` in `config.local.json` before `npm run check`. A real retailer session may expire or encounter a CAPTCHA. The CLI and extension have independent attempt locks. Running both as live buyers can duplicate an order. [Chrome Headless documentation](https://developer.chrome.com/docs/automation-and-testing/headless)

### MV3 extension in Daniel · d

| Source | Responsibility |
| --- | --- |
| [manifest.json](extension/target-shipping/manifest.json), [popup.html](extension/target-shipping/popup.html), [popup.js](extension/target-shipping/popup.js) | Permissions, controls and message construction. The popup sends `arm`, `stop` and `reset-watch` to the worker. The popup and worker use the same Pro URL check. On another page the popup offers a link to the correct listing. Only purchase mode accepts an optional 3–4 digit CVV. It shows the code-ready flag while armed. |
| [shipping.js](extension/target-shipping/shipping.js) | `observeShipping` runs inside the armed product document. A MutationObserver reports state changes. A unique enabled Pro Add and the selected shipping method gate the cart action. `cartAcknowledgement` recognizes the drawer or a cart-count increase. |
| [verification.js](extension/target-shipping/verification.js) | `advanceVerification` handles only the known popup on the armed Pro listing before shopping attempts. Chrome's extension DOM API reads the closed shadow container. Exactly one visible challenge frame and exact enabled control labels are required. One accessibility pointerup precedes one Press again pointerdown/pointerup pair by at least three seconds. A visible acknowledgement must follow the first input within five seconds; sending an event alone does not establish acceptance. Per-overlay reservations survive worker suspension and reject rearming the same overlay. The worker owns cancellable polling; no delayed clicks run in the page. A 45-second timeout or changed evidence requires manual attention. Checkout verification remains a review stop. |
| [worker.js](extension/target-shipping/worker.js) | Serializes alarms, tab events and commands for one watch key. Moves an acknowledged Add through cart, checkout and receipt. `stageWatch` persists the next phase before navigation. `advanceCheckout` drives it. DOM polling during checkout only reads the existing document until a validated action is ready. |
| [checkout.js](extension/target-shipping/checkout.js) | `checkoutPage(stage, order, proof, commit, securityCode)` runs in the tab's isolated JavaScript world. Helpers used here must be available inside the serialized function. Inspection returns `ready`, `wait` or `review` with evidence. A commit repeats the checks in the matching document immediately before a click. |
| [rehearse.html](extension/target-shipping/rehearse.html), [rehearse.js](extension/target-shipping/rehearse.js) | Consume a one-use tab ticket for the separately invoked base rehearsal. This can add the base item to a live cart and open order review. The ordinary rehearsal stops before submitting and attempts to return its test item to Saved for later. |
| [base-cvv-test.js](extension/target-shipping/base-cvv-test.js) | The distinct, single-use base test starts at a verified review. With its own authorization it can click Place once. It fills the matching drawer and stops before Confirm. Its durable lock is separate from the Pro locks. |

**Order sequence.** `arm` binds the tab and creates the alarm. Shipping availability can finish as an alert or enter `tryCart`. For a purchase, the worker records `cartAttempt`, clicks Add, waits for acknowledgement and opens the cart. The cart proof comes from the **active** line with the expected TCIN, quantity and shipping method. Saved-for-later entries and recommendations cannot establish identity. Final review independently checks the checkout item, count, destination, saved payment and final amount.

**Saved card.** Checkout derives `cardTag` from the masked brand and ending shown for the single saved method covering the entire total. It carries that tag and the verified cents forward as session proof. The user supplies only the optional CVV. A card or amount change between inspection and the actual order click stops the attempt. If a CVV drawer appears, it must match the reviewed card. The worker consumes the code once and revalidates the drawer before Confirm. Only a merchant receipt with confirmation evidence finishes as `confirmed`. Target may accept Place immediately. The first submit must already meet every spending and item check.

| State owner | Data and recovery |
| --- | --- |
| Target `chrome.storage.session` | `watch`, phase, proof, `reading`, last confirmed unavailable reading and refresh time. `pendingCard` contains only the watch key and optional code. A stop or finish removes it. The worker removes it before a fill. Browser restart or extension reload clears this session and requires rearming. |
| Target `chrome.storage.local` | `lastAvailableAt`, `cartAttempt`, `previousCartAttempt`, `orderAttempt`, `lastPurchaseResult`, and base-test records. The worker writes the order lock before Place and adds `codeAttemptAt` before CVV entry. Before an order reservation, Reset holds queued purchase work, disarms, clears the Add lock and returns to idle. It archives the Add time and preserves the shipping detection time. Once an order attempt exists, Reset is locked and receipt handling continues. The older `reset-cart` message remains a stopped-watch-only operation. |
| Target Node CLI | `.runtime/run.lock` identifies the browser process run and `.runtime/state.json` tracks `adding`, `cart`, `checkout`, `submitting`, `submitted`, `confirmed` or `needs-review`. These files belong to the CLI alone. |
| Public HTTP comparison | `.runtime/target-public-changes.jsonl` contains observations. A new process starts a fresh comparison baseline. |

## Sony runtimes

| Source | Responsibility |
| --- | --- |
| [src/ps_cart.mjs](src/ps_cart.mjs) | Optional Node child of the Python watcher. Receives an Add signal over stdin and operates its dedicated signed-in Chrome profile. Claims an attempt before a visible Add click. |
| [src/ps_native.py](src/ps_native.py) | Separate native-messaging host implementation for reading local watch state and reserving an attempt. The current Sony extension manifest omits native messaging and watches its own product tab. |
| [Sony manifest](extension/sony-cart/manifest.json) | Permissions for the armed Sony tab and notifications. Extension pages have no outbound connection permission in their CSP. |
| [worker.js](extension/sony-cart/worker.js), [page.js](extension/sony-cart/page.js) | The alarm refreshes a signed-in Pro page showing Currently Unavailable, at most once per document ID. DOM mutations and completed navigation request fresh observations. The exact visible Add in the product hero can trigger one reserved click. Queues, verification and unknown controls hold the tab. |
| [popup.html](extension/sony-cart/popup.html), [popup.js](extension/sony-cart/popup.js) | Arm/disarm, Locate tab, base Add trial, test notification and detection times. Session state binds one tab. Local storage retains the Add reservation and up to 100 observed transitions. |

Sony's Python watcher owns `.runtime/ps-direct/watch.lock`, `state.json` and `events.jsonl`. The optional helper owns `cart-profile`, `cart-state.json` and `cart-attempt.json` in the same directory. `ps:status` checks the process lock. Old log entries alone do not prove that a process is running.

## Verification from a terminal

Run at the repository root. Python unit tests use local fixtures or temporary files. Browser checks below use temporary Chrome profiles and fixture responses. The signed-in variant creates a disposable test session, closes visible Chrome, and requires that session on fresh headless requests all the way through the simulated receipt.

```sh
npm test
python3 -B -m unittest discover -s test -p 'test_*.py'
node checks/shipping.mjs
node checks/target_shipping_extension.mjs
node checks/target_verification.mjs
node checks/target_checkout.mjs
node checks/target_checkout.mjs --signed-in-profile
node checks/ps_extension.mjs
node checks/ps_direct_cart.mjs
node checks/ps_background_click.mjs
```

| Behavior | Checks to read first |
| --- | --- |
| Target policies, timing and restart locks | [test/safety.test.mjs](test/safety.test.mjs) |
| Target public shipping, optional publisher parser and time-series changes | [test/test_shipping_http.py](test/test_shipping_http.py), [test/test_target_changes.py](test/test_target_changes.py) |
| Rendered Target shipping and the armed tab | [checks/shipping.mjs](checks/shipping.mjs), [checks/target_shipping_extension.mjs](checks/target_shipping_extension.mjs) |
| Known Target verification popup, hidden frame copies, one-use clicks and cancellation | [checks/target_verification.mjs](checks/target_verification.mjs). The local harness supplies Chrome's closed-root access; it does not establish live CAPTCHA acceptance. |
| Cart, checkout, popup, saved-card changes, base test and duplicate prevention | [checks/target_checkout.mjs](checks/target_checkout.mjs). The optional session handoff is in [checks/signed_in_profile.mjs](checks/signed_in_profile.mjs). |
| Sony parser, retry behavior, watcher and native host | [test/test_ps_direct.py](test/test_ps_direct.py), [test/test_ps_native.py](test/test_ps_native.py) |
| Sony Add, queue/extension state and hidden-tab button behavior | [checks/ps_direct_cart.mjs](checks/ps_direct_cart.mjs), [checks/ps_extension.mjs](checks/ps_extension.mjs), [checks/ps_background_click.mjs](checks/ps_background_click.mjs) |

For live evidence, the base checkout rehearsal and the later, separately authorized CVV attempt are different runs. The first reached review. The second clicked Place, observed the real Target drawer, verified the fill and stopped with zero Confirm clicks. The Pro Confirm-to-receipt sequence has browser-fixture coverage. The recorded base result does not establish a live Pro purchase or a working payment HTTP API. [Rehearsal runs](checks/target-base-checkout-2026-11-19.json) · [Live CVV record](checks/target-live-cvv-stop-2026-11-19.json)
