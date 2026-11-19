# PS5 Pro stock monitors

For a terminal-based coding agent, start with the [codebase guide](AGENTS.md). It maps the public HTTPS readers, headless CLI, extensions, checkout states and test evidence to their source files.

## PlayStation Direct US

The PlayStation Direct monitor uses Python 3 and HTTPS GET requests to Sony's public product page. It checks the primary product's SKU and its Schema.org Offer availability. The page contains hidden templates for both Add and Currently Unavailable, so matching the page text alone would give false alerts.

```sh
npm run ps:check -- --model both  # One check of the Pro and the 1 TB disc model
npm run ps:watch                  # Watch only the Pro, every 3 seconds
npm run ps:watch -- --interval 1  # Independent one-second Mac notification, no cart helper
npm run ps:watch -- --add-to-cart # Also open dedicated Chrome for sign-in and one Pro add attempt
npm run ps:test-alert             # Clearly labeled test Mac notification
npm run ps:window                 # Open Sony in the running helper’s Chrome profile, e.g. to sign in
npm run ps:status                 # Running state and the last stock reading
npm run ps:stop                   # Stop the current Pro watch
```

Watch mode exits at the first confirmed `InStock`, records the result locally and rings the terminal bell. On macOS it also requests a desktop notification (subject to system notification settings). Status and stop work from a separate terminal. Use `-- --interval 10` to change the interval. The watch uses conditional GETs when Sony provides cache validators, honors Retry-After and backs off on network or server failures. It stops for an unrecognized product page, queue redirect or access denial. Keep the Mac awake and connected. The default mode only checks availability. With `--add-to-cart`, sign in directly with Sony in the dedicated Chrome profile before the drop. The helper observes the storefront account controls and reports its current state under cartHelper. It requires positive signed-in evidence on the product page immediately before Add. A signed-out or unverified session still receives stock alerts and skips the cart action. On a confirmed restock the helper uses Sony’s visible Add button for SKU 1000050805 once and leaves the page open. Status reports whether the click was confirmed or needs review. A durable `.runtime/ps-direct/cart-attempt.json` prevents repeats across restarts. If it already exists, inspect your cart before clearing it for a future run. The helper never submits payment.

### Use your existing signed-in Chrome tab

Load `extension/sony-cart` in the **Daniel · d** Chrome profile. With the signed-in US Pro product page selected, click **Arm this tab**. The extension requests a page check every three seconds and refreshes the same tab only after Sony displays **Currently Unavailable** for that product. Each completed document can be refreshed once. A slow page load extends the actual interval. A DOM observer also wakes the worker when the product controls change.

The watcher verifies the Pro page title, canonical URL, SKU 1000050805, signed-in state and visible product controls. When the unavailable message clears and Sony enables the Pro Add button, it reserves one attempt, clicks Add, and looks for Sony's acknowledgement. Conflicting controls, a loading page, a frozen tab, a queue and human verification suspend refreshes. The original tab stays in place. Detection times and cart outcomes are recorded locally. Checkout is manual.

The extension makes zero separate public inventory requests. The optional Python HTTPS monitor is independent. Use `npm run ps:status` to inspect that process and `npm run ps:stop` to end it. In the popup on the base 1 TB tab, the manual Add test is scoped to SKU 1000049888. A repeat after a previously recorded attempt requires an empty cart reading. It does not arm the Pro.

### Queue evidence and detection times · November 19, 2026

Sony’s September 10, 2026 US controller event is the newest event for which we verified the waiting-room text against screenshots. Sony dated the sale in its [announcement](https://blog.playstation.com/2026/09/03/first-look-at-the-grand-theft-auto-vi-limited-edition-dualsense-wireless-controllers/). The [paused room](https://cdn.mos.cms.futurecdn.net/tGwsbEnXoGGVxLiojvd5FD.jpg) and [moving room](https://cdn.mos.cms.futurecdn.net/553dgptyNJ8JsYWAt2dGkE.jpg) used the same heading. The status underneath changed from a paused line to an estimated wait exceeding an hour. Either state means wait on that tab. Neither is an inventory offer.

Sony’s [July 21, 2025 US restock screen](https://cdn.mos.cms.futurecdn.net/SxfVHtmH6bEr9skwiMafjF.jpg) said the waiting page updates automatically. For *that event*, the countdown assigned a random place, and extra tabs or manual refreshes did not improve it. The [September 2024 US Pro screen](https://cdn.mos.cms.futurecdn.net/bg8Xaz5B8KwbtAcSzn29TV.jpg) corroborates the waiting-room and paused-line wording. We found no published November 2026 US Pro rule promising a queue, a fixed admission window or a reservation. [Queue-it’s layout guide](https://queue-it.com/media/rxflpm0x/queue-it-custom-layout-white-paper.pdf) documents a possible turn prompt in an inactive browser tab. Its example timer is not a Sony guarantee.

Keep the original tab open and follow the instructions shown. If the queue directs you to confirm entry or returns you to a Sony landing page, complete that step yourself in the same tab and return to the Pro listing. The extension never chooses a queue link or changes a queue position. Another origin, a login, a frozen tab or a generic redirect can prevent it from reading the screen. The extension checks the same tab again after ordinary shopping resumes. The independent Mac HTTP checker cannot determine your position in a browser queue.

The popup’s **Detection times** records up to 100 transitions in extension-local storage. It shows device-local time to milliseconds; hover for UTC. The Mac watcher appends UTC events to `.runtime/ps-direct/events.jsonl` before sending alerts. Both record *when they observe the evidence*, not Sony's restock time. The pollers have different intervals; sleep, network delays and caching can widen the gap. There is no historical reconstruction for events before this logging was installed.

## Target


A standalone Node.js program for Target TCIN **93620188**. The configured purchase is **one console, shipped to ZIP 75013, maximum $1,100 including tax and shipping**.

## Run

Requires Node.js 22+ and installed Google Chrome. Dependencies are installed in this workspace; on another machine run `npm ci`.

```sh
cd '/Users/gnarayan/Desktop/texasrivertrading/ps5 sniper'
npm run setup
```

Setup opens a dedicated Chrome profile. Sign into Target yourself, select Shipping and delivery ZIP 75013, empty the cart, and make sure your saved shipping address and payment method are ready. Return to the terminal and press Enter. Credentials stay in that local browser profile; the bot does not read your ordinary Chrome profile or ask you to put passwords/card numbers in configuration.

```sh
npm run check   # One read-only stock check
npm run check:http  # Browserless, read-only Pro listing check (requires Python 3)
npm run check:http -- --model both  # Also compare the base Digital Edition
npm run check:http -- --model both --details  # Include SKU-specific catalog flags
npm run check:report  # Independent publisher's Target (Delivery) row for the exact Pro TCIN
npm run check:session  # Separate inventory test using the dedicated Chrome session
npm start       # Continuous monitoring; never adds or buys
npm run buy     # Monitor, add one, and attempt checkout once
```

Stop with Ctrl+C. Keep the process running, Chrome open, and the computer awake. This is not a hosted service and does not run while the computer sleeps.

During a stock check in visible Chrome, a detected CAPTCHA rings the terminal bell and pauses stock requests. Complete the challenge in that window. The program resumes observing the page when the prompt clears. A server denial without an interactive prompt ends the check. Purchase actions are never replayed by the verification wait.

The browserless command uses the Python standard library to GET public product HTML. By default, `shipping` reports the current offer shown for the selected model without requiring a ZIP. Pass `--zip 75013` only to require an offer for that destination. This filter checks the returned HTML. The separate `shippingEligible` field reports Target’s catalog setting for ship-to-guest orders. An active catalog setting and a loading tile yield `shippingEligible: true` and `shipping: "unknown"` (exit code 2).

### Compare fresh Target responses over time

```sh
npm run target:changes -- --model both --rounds 4 --interval 12
```

This experiment makes an independent public HTTPS request for each console every round. It uses no Chrome tab, account, ZIP or external stock service. Each response is compared with the previous one for that same console. A `shipping_data_changed` event records changes to the Shipping button or an explicit shipping status in the item's embedded data. An unfamiliar label is recorded even if its meaning is unknown. `other_page_bytes_changed` means only the document hash changed among the fields being compared.

The default log is `.runtime/target-public-changes.jsonl` with UTC observation times to the millisecond. Use `npm run target:changes` for an ongoing Pro-only terminal session with a 30-second pause between checks. Ctrl+C ends the session. The reader backs off on rate limits, stops on an access challenge, and only writes to the terminal and log. In the November 19 comparison, the base console offered shipping in Chrome while its raw HTML still returned a loading placeholder. This mode can miss a restock for as long as Target serves that placeholder.

## How the browser monitor works

The program observes inventory GET requests made by the product page. If it recognizes a request for this exact product and ZIP, with a recognized shipping-availability response, it replays that request through Playwright's HTTP client using the session's cookie jar. This avoids page rendering for those checks. Inventory request URLs, keys and cookies are not logged or saved separately.

The browser reads the PS5 Pro’s Shipping tile and detail panel. An arrival estimate or a low-stock count such as “Only 1 left” can qualify shipping. The “Ship to” ZIP identifies the destination, with the delivery ZIP in the header as a fallback. Pickup and same-day delivery are independent. Read-only page checks report the displayed shipping state even when Target omits the ZIP. The rendered Shipping button also carries an availability class that can identify an offer independently of its wording or whether the tile is selected. If Target changes the shipping wording, the monitor can ring a separate “possible” alert when Shipping is explicitly selected, the shipping panel shows the configured ZIP, and the console’s own cart button is enabled. A possible alert requires you to inspect the offer and never triggers a cart action. A positive HTTP signal triggers the same page check.

With a working inventory endpoint, the program checks every 5 seconds and refreshes the browser session about every three minutes. When only the product page is available, it checks every 15 seconds. Intervals run from the start of a check. Slow responses skip missed checks. Override `pollSeconds` and `browserPollSeconds` in `config.local.json` to adjust each interval. Rate limits and server errors delay the next check, including any longer Retry-After value from Target. An access denial stops monitoring.

Before buying, the program verifies the exact product, an empty cart, shipping availability, and product price. At checkout it requires explicit evidence for the item count, product, quantity, fulfillment, destination ZIP, Target as seller, saved payment, absence of add-ons, and final total. Missing or changed markup stops the purchase. It does not choose a different card or address automatically.

## Purchase recovery

The program writes `.runtime/state.json` **before** add-to-cart and **before** order submission. After any mutation or ambiguous outcome, a new `--buy` run is locked. Inspect your Target cart and order history before manually removing that state file. Never clear it simply to retry a timed-out order.

`.runtime/run.lock` prevents simultaneous instances. A hard crash can leave this lock behind. Read its PID and confirm the process has exited before removing it. The entire `.runtime` directory is private and ignored by Git; it contains your signed-in browser session.

## Validation and limitations

`npm test` checks polling cadence, spending limits, inventory recognition and restart safety. Use `npm run check:session` to test the dedicated Chrome session or `node src/diagnose.mjs` for a separate fresh-session diagnostic. HTTP verification requires an actual direct GET returning recognized shipping inventory for the configured product and ZIP. A successful listing page load alone leaves inventory unverified.

The standalone CLI's live checkout and direct inventory path remain unverified. A read-only diagnostic received HTTP 435 for store-location requests and did not discover a usable shipping response. The separately tested Chrome extension reached a live base-console CVV drawer. See the [verification records and headless fixture commands](AGENTS.md#verification-from-a-terminal) for the scope of each result.

The browser session's HTTP client shares cookies with the browser as documented in [Playwright APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext). Session persistence uses [launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).

## Target Chrome shipping alert

While armed on the Pro listing, the watch clicks a visible, enabled **Dismiss** link that matches `#notice > a[role="button"][aria-label="Dismiss notice"]` and has no `href`. It clicks once while that control remains visible. Product identity and verification checks run first.

While armed on the Pro listing and before any shopping attempt, a visible `iframe#px-captcha-modal` holds shipping actions and refreshes. The extension identifies the inspected **Quick verification** document, reads its closed shadow container using Chrome's [extension DOM API](https://developer.chrome.com/docs/extensions/reference/api/dom), and requires exactly one visible challenge frame. It sends one `pointerup` to the enabled **Accessible challenge** control. A visible response (the accessibility control becoming disabled or **Press again** appearing) must follow within five seconds. After at least three seconds from the first input, it sends one `pointerdown`/`pointerup` pair to the enabled **Press again** control. Hidden frame copies cannot qualify. The three-second delay is an operator preference, not a verified Target timing requirement. The [observed event types](checks/target-verification-events-2026-11-19.json) explain why the earlier `.click()` implementation did not activate the gray control.

Stop and Reset cancel pending verification work. The handler never retries either activation on the same overlay, including after rearming. Changed or ambiguous controls, inaccessible frames, ignored input, or a prompt that remains after 45 seconds end the watch with a notification for manual attention. An unrecognized verification screen still stops immediately. Once the overlay clears, the watch rereads shipping; disappearance alone does not establish successful verification or availability. Verification during checkout, or after an Add/order reservation, still requires reviewing the cart and order history. The handler has local browser-fixture coverage using the observed event types; Target accepting these synthetic events has not been established. Stop the watch, reload the unpacked extension, reload the Target tab, and rearm to use updated code. Reloading the tab gives the updated handler a fresh document; rearming the same already-attempted overlay is deliberately blocked.

Load `extension/target-shipping` only in Daniel · d. Open the Target PS5 Pro listing (TCIN 93620188) and choose **Target PS5 Pro Shipping**. The watch reads the rendered Shipping tile every three seconds and observes DOM changes. It detects updates Target renders on that tab. The optional refresh checkbox requests a normal reload only after a confirmed unavailable reading, once per loaded document.

Choose **Buy one Pro · $1,100 total max** and click **Arm one Pro purchase** on the Pro listing to enable automatic checkout. Existing Add-only watches keep their original setting. The extension follows the acknowledged Add to the cart, verifies the active shipping line and quantity, and opens checkout. A Pro under Saved for later or recommendations cannot qualify. At checkout it matches the item again, checks shipping to ZIP 75013, the saved payment and the final total including taxes and shipping. It clicks Place your order once and looks for Target’s confirmation. A changed cart, human verification or an unverified order requires review in the original tab.

For Target’s **Confirm CVV** drawer, enter only the optional security code when arming. At order review the extension reads the masked identity of the saved card selected for the entire charge. It checks that same card and total before Place, before filling a matching drawer and before Confirm. Chrome holds the code in extension session memory and clears it on stop, use or restart. Leaving the code blank still permits a purchase. A CVV prompt then stops the watch for review.

The top of the popup shows current readiness. **Open PS5 Pro listing** opens the correct page if the active tab cannot be armed. After a missed Add, inspect your active cart and use **Reset Add attempt**. It stops any pre-order watch, preserves the Add timestamp, clears the attempt and leaves the watch disarmed. Use **Reset watch** to dismiss a stale status. Once an order attempt exists, check Target order history. Reset cannot unlock a second submission.

The other modes are **Add one Pro to cart** and **Alert only**. On the base Digital Edition tab, **Check base PS5 Shipping once** reads stock. **Rehearse base checkout without ordering** starts from an empty cart, adds one demo unit, verifies the actual cart and order review, and checks for a pre-submission card-code prompt. It never presses Place your order or confirms payment. It returns the test unit to Saved for later unless a real code drawer is left open for inspection. The popup keeps the most recent shipping detection, Add attempt and order attempt times.

The separately authorized **one-time base CVV test** starts from a verified Digital Edition checkout. It checks the selected card and the all-in $649.49 ceiling, records one attempt before pressing **Place your order**, and observes the result. Target can immediately accept a real order. When the matching **Confirm CVV** drawer appears, the extension fills the field, verifies entry, brings that tab forward and stops. The base test contains no action to click **Confirm**. Its attempt record prevents replay.
