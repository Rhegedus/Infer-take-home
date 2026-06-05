# Walkthrough - Extraction Stabilization

We have successfully stabilized the extraction flow for both carriers (AAA and Lemonade) to run reliably under local development and remote serverless environments.

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
