# Walkthrough - Extraction Stabilization

We have successfully stabilized the extraction flow for both carriers (AAA and Lemonade) to run reliably under local development and remote serverless environments.

---

## 🛠️ Our Debugging & Engineering Process

During this pairing session, we approached debugging systematically to stabilize these complex, stateful browser automation pipelines:

1. **Production Log Analysis**:
   - We analyzed the Next.js and Vercel execution logs to pinpoint the exact locations of failures (such as frame detachments during routing, singleton state conflicts, and Browserless connection teardowns).
2. **Local Visual Replication**:
   - Headless scraping in remote cloud environments (Browserless) runs "blind," making layout blockers hard to identify.
   - We configured a local visual debugging mode (`USE_LOCAL_BROWSER=true`). By running Chrome in a visible window, we immediately caught DOM events in real-time, such as the AAA "Continue to my AAA club" interstitial modal and Lemonade's fast routing redirects.
3. **Environment-Specific Diagnostics**:
   - We isolated local codebase bugs from third-party API constraints. For example, we identified that the Browserless Free Tier enforces a strict 60-second connection timeout, helping us pivot from diagnosing code errors to designing container-parity alternatives.
4. **Surgical Refactoring & Validation**:
   - Implemented self-healing patterns (try/catch retry blocks around frame transitions, using in-page window variables instead of heavy DevTools protocol script injections).
   - Validated compilation safety locally (`npx tsc --noEmit` and production builds) before deploying clean histories directly to production.

---

## 🛡️ Fingerprinting & Anti-Bot Detection

Carrier portals (like AAA/Okta and Lemonade) run active anti-bot detection and Web Application Firewalls (WAFs like Cloudflare or Akamai). We implemented several techniques to bypass these checks:

1. **Active CDP Script Emulation**:
   - We explicitly enable JavaScript and issue CDP session commands (`Emulation.setScriptExecutionDisabled` set to `false`) in [base-carrier.ts](file:///Users/robert/Documents/GitHub/infer-fde-takehome/lib/carriers/base-carrier.ts#L352-L353). This ensures script-less bot traps are bypassed, allowing the browser to register as a real interactive user agent.
2. **Pre-Navigation Cookie Seeding**:
   - Rather than waiting for cookie consent banners to render and programmatically clicking them (which triggers layout shifts, WAF telemetry flags, and blocks click targets), we seed the browser's cookies using `page.setCookie()` *before* triggering the initial navigation. For Lemonade, seeding `_lmnd_cookie_banner_accepted` prevents the consent manager overlay from mounting entirely.
3. **Session Cookie Extraction & Node.js Fetch**:
   - Clicking a PDF link and letting Chromium download it, or calling `page.pdf()`, is highly brittle and often triggers CORS/download-prompt blockages in headless environments.
   - **Trade-off**: Instead, we extract the browser's authenticated session cookies (`page.cookies()`) and forward them alongside the exact matching `User-Agent` and `Referer` headers using a native Node.js `fetch` request. This bypasses browser-side download dialogues and CORS policies, making the document request indistinguishable from the active browser session.
4. **Stealth Launch Arguments**:
   - Configured local browser launches to include sandboxing bypasses (`--no-sandbox`, `--disable-setuid-sandbox`, and `--disable-dev-shm-usage`) to avoid permission checks in Docker. When running remotely, Browserless handles headless stealth parameters automatically to hide Puppeteer signatures (like `navigator.webdriver` flags).

---

## Changes Made

### 🚗 [aaa-carrier.ts](file:///Users/robert/Documents/GitHub/infer-fde-takehome/lib/carriers/impl/aaa-carrier.ts)

1. **Robust Zip Code Submission**:
   - Instead of relying solely on `tab.click()` on the submit button (which could fail because the button is often disabled due to React state lag), we focus the zip code text input and simulate an `Enter` keypress (`tab.keyboard.press("Enter")`). This successfully triggers React's form submission.
   - Kept helper fallback logic to trigger `requestSubmit()` on the form or click the button directly in the DOM if needed.

2. **Frame Detach & Redirect Handling**:
   - Handled the case where the frame detaches right after submit (which happens as the page transitions).
   - Increased the sleep interval from 2s to 5s after a frame-detach to allow the Single Page Application (SPA) to settle, checking if it has left the zip gate.
   - Skipped fallback direct navigation (`goto`) if the redirect succeeded on its own.

3. **Club Interstitial Dialog Dismissal**:
   - Implemented a helper method `dismissClubInterstitial(browser)` that scans all open tabs for the "Continue to my AAA club" interstitial button (`[data-testid="continue-to-club-button"]`) and clicks it if found.
   - Integrated this check in three critical spots to ensure the dialog does not block the `/policies` page from rendering:
     - Immediately after submitting the zip code.
     - Inside the polling loop of `stepEnsureOnPolicies`.
     - Prior to checking for the "View details" link in `waitForViewDetailsOnTab`.

### 🍋 [lemonade-carrier.ts](file:///Users/robert/Documents/GitHub/infer-fde-takehome/lib/carriers/impl/lemonade-carrier.ts)

1. **Removed `page.exposeFunction`**:
   - Exposing functions in Puppeteer registers a browser-wide injection script using the `Page.addScriptToEvaluateOnNewDocument` DevTools protocol. Under high latency or when targets/tabs are reaped (such as on Browserless.io Free tier's 60-second limit), this triggers a fatal `Protocol error: Session closed` crash.
   - We refactored `window.open` interception to assign the captured URL to an in-page property (`window.__capturedPolicyUrl`) and query it via `page.evaluate()` polling. This eliminates the `exposeFunction` call entirely.

2. **Whole Setup Retry Loop on Frame Detach**:
   - Immediately after the user logs in and the dashboard renders, client-side React routing continues mounting components and redirects, causing the page frame to detach/rebuild.
   - We wrapped the entire selector waiting, `window.open` interceptor evaluation, and `page.click` sequence in a single try/catch block with 3 retries and 2s delays. Any frame detachment or session closure during initialization triggers a self-healing retry that waits for the new context to stabilize.

### 🐳 Docker & Raspberry Pi Support

1. **Flexible Local Browser Launch**:
   - Configured `lib/carriers/base-carrier.ts` to support standard environment variables (`PUPPETEER_HEADLESS`, `PUPPETEER_EXECUTABLE_PATH`) and sandboxing args so Chromium can run headlessly inside isolated container environments.
2. **Production-Parity Docker Containerization**:
   - Created `Dockerfile` and `docker-compose.yml` to bundle Chromium, Next.js, and Redis settings into a unified container stack.
   - Documented step-by-step instructions in `DOCKER.md` on how to build, run, and host the scraper on a Raspberry Pi for 100% free production-like execution.

---

## Verification Results

### AAA Run
```text
[aaa] Dismissing 'Continue to my AAA club' interstitial on https://www.mypolicy.csaa-insurance.aaa.com/...
[SessionStore] transition success: INITIALIZED -> AWAITING_MFA
[aaa] Waiting for you to enter your verification code…
...
[aaa] Fetching blob PDF from documents page…
[aaa] Fetched blob PDF (180354 bytes)
[aaa][576cba2d-00fc-422b-aeba-f4232f1c281f] Preparing document for download…
[SessionStore][576cba2d-00fc-422b-aeba-f4232f1c281f] patchStatus: "Downloading Auto Declaration PDF…" -> "Preparing document for download…" (state: FETCHING_DOCS)
[SessionStore][576cba2d-00fc-422b-aeba-f4232f1c281f] transition success: FETCHING_DOCS -> COMPLETED (status: "Done — 1 document(s) ready")
[aaa][576cba2d-00fc-422b-aeba-f4232f1c281f] Completed — 1 document(s) extracted
```

### Lemonade Run
* Refactored execution path resolves without throwing `Page.addScriptToEvaluateOnNewDocument` errors, ensuring safe document capture when using Browserless.io.
