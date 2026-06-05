# Challenges Faced & Solutions

This document outlines the major technical challenges encountered during the development and stabilization of the DocExtract scraper, and how we solved them.

---

## 🔑 1. Passwordless / MFA Flows in Serverless

### The Challenge
Serverless environments (like Vercel) have strict execution timeouts and cannot maintain long-lived state or persistent browser sessions. The extraction process for both carriers requires waiting for human intervention (entering email OTP for Lemonade or SMS/Okta codes for AAA).

### The Solution
We implemented a state machine coordinated through **Upstash Redis**:
* When an MFA screen is reached, the headless runner transitions the session state to `AWAITING_MFA` and enters a polling sleep loop.
* The frontend receives this status, prompts the user for the code, and writes the submitted code to Redis.
* The runner detects the code in Redis, transitions to `MFA_SUBMITTED`, inputs it into the browser, and proceeds with the extraction.
* This architecture keeps the serverless execution decoupled, stateful, and resilient.

---

## 🍋 2. Lemonade: SPA Target/Tab Interception & Frame Detachment

### The Challenge
* Lemonade opens the policy PDF in a new tab. In headless mode, if we tried to print the page to PDF (`page.pdf()`), it would frequently throw `printToPDF: Target closed` due to the tab loading asynchronously or the document closing too quickly.
* **Post-MFA Frame Detachment**: Immediately after verifying the MFA code, Lemonade's Single Page Application mounts the dashboard and updates client routing. On Vercel, this rapid client-side transition can cause Puppeteer to throw `Attempted to use detached Frame` if the scraper queries the policy card selector while the frame is reloading.

### The Solution
* We set up a target listener (`browser.waitForTarget`) to intercept the newly opened tab as soon as the "View Policy" action is triggered.
* Once the tab is acquired, instead of rendering a PDF printout, we extract the browser's cookies and perform a standard Node.js `fetch` to download the document.
* We stripped out fixed consent overlays and cookie banners programmatically before extraction to prevent visual blocking.
* **Frame Detach Retry**: Wrapped the dashboard policy-card `waitForSelector` in a retry loop (up to 3 attempts with a 2-second sleep). If a transient `detached Frame` error occurs during client routing, the scraper waits for the new frame context to settle and successfully locates the policy card on the next attempt.

---

## 🚗 3. AAA: Zip Code Gate React Event Lag

### The Challenge
After entering the zip code on the `/policy-zip` page, clicking the "Continue" button programmatically failed. Because of React's state synchronization lag, the button element was technically disabled in the DOM when Puppeteer clicked it, preventing the submit event from firing.

### The Solution
We changed the submission strategy:
* Instead of clicking the button, we programmatically focus the zip input field and press the `Enter` key via Puppeteer's keyboard API.
* This fires a native keyboard event that triggers form submission regardless of the button's visual/disabled state, bypassing React's event-binding lag.

---

## 🚗 4. AAA: SPA Navigation & Frame Detachment Races

### The Challenge
AAA's SPA redirect immediately detaches the active frame when navigation starts, leading to standard Puppeteer `Frame detached` errors when attempting to query elements or check the URL.

### The Solution
* We wrapped the zip submission in try/catch blocks that specifically identify frame-detachment errors as successful signals of starting navigation.
* We increased the sleep timeout to 5 seconds to let the SPA transition fully settle before checking if the browser successfully left the zip gate.
* Added safe tab resolution helpers (`resolveActiveMypolicyTab`) to find the most up-to-date active tab rather than driving a stale, detached page handle.

---

## 🚗 5. AAA: "Continue to my AAA club" Interstitial Modal

### The Challenge
A modal dialog box (`Continue to my AAA club`) occasionally pops up after zip gate submission, blocking the flow and preventing the policies dashboard from rendering. This caused the session to hang indefinitely.

### The Solution
* We introduced a global helper `dismissClubInterstitial(browser)` that checks all open pages for the interstitial's continue button (`[data-testid="continue-to-club-button"]`) and clicks it.
* We wired this helper into three distinct parts of the flow:
  1. Immediately post-submit.
  2. Inside the `/policies` dashboard polling loop.
  3. Right before checking for the "View details" link on the policies page.

---

## 💻 Local Development

### Visual Browser Debugging
When running headless in a remote container, debugging a hanging flow is extremely difficult because you cannot see the visual UI state. 

* **The Challenge**: The AAA flow was hanging at the interstitial dialog step, but console logs only showed `Waiting for policies dashboard to render...` without indicating why the page was stuck.
* **The Solution**: We enabled a visual debugging mode using `USE_LOCAL_BROWSER=true npm run dev` locally. This launched a physical Chromium browser window on the local machine instead of offloading to Browserless. 
* By observing the page in real-time, we immediately saw the "Continue to my AAA club" popup window overlaying the policies dashboard, allowing us to capture the button selector (`[data-testid="continue-to-club-button"]`) and programmatically dismiss it.

---

## 🌐 6. Vercel / Serverless Environment Execution Freeze

### The Challenge
On Vercel, serverless function instances are immediately frozen or suspended as soon as the HTTP handler returns a response. When `/api/carriers/run` returned `{ ok: true, sessionId }` immediately (which is needed to let the frontend start polling and not time out the HTTP request), the background promise running the browser extraction (`this.run(...)`) was immediately suspended. This caused the session to hang in `INITIALIZED` state indefinitely on Vercel with zero logs or output.

### The Solution
* We updated `BaseCarrier.start()` to return both the `sessionId` and the background extraction `promise`.
* In `app/api/carriers/run/route.ts`, we imported Next.js's native **`after`** API.
* We wrapped the background extraction promise inside `after()`. This explicitly registers the task with the Next.js runtime, ensuring Vercel keeps the execution context alive and active after sending the response to the client.
* We also exported `maxDuration = 300` in the route handler to configure Vercel's timeout limit to 5 minutes to accommodate the full extraction flow.

### Lesson Learned: Vercel Immutable Preview URLs
* When deploying on Vercel via Git integration, every commit generates a **unique, immutable preview deployment URL** (e.g., containing a hash like `-if27e4cmo-`).
* Accessing an older preview URL runs a frozen snapshot of the code from that exact past commit, which will not receive updates from subsequent pushes. To verify updates, always use the main branch/production domain or grab the latest deployment link from the Vercel dashboard.

---

## 🌐 7. Browserless Session & Idle Connection Timeouts

### The Challenge
When running in production/Vercel, the browser connection to Browserless.io would occasionally drop with `Session closed. Most likely the page has been closed.` when executing commands post-MFA. This was caused by two distinct timeout mechanisms:
1. **Idle Connection Timeout**: During the `AWAITING_MFA` phase, the Node.js process is polling Redis for several minutes without sending any commands to the browser. Load balancers or Browserless themselves close the WebSocket due to inactivity if no data flows for 30 seconds.
2. **Session Timeout**: Browserless has default session lifetime limits (like 60 seconds on the Free plan, or standard limits on other tiers) that terminate the container early if not configured otherwise.

### The Solution
* **Heartbeat Ping**: We updated the `awaitMfaCode` polling loop to execute `await this.browser.version()` on every iteration. This sends a lightweight command over the WebSocket connection, acting as a heartbeat that prevents idle timeouts.
* **Configurable Session Timeout**: We avoided hardcoding a default `&timeout=300000` (5 minutes) query parameter in code. Hardcoding it causes Browserless to reject the connection with a `400 Bad Request` if the user is on the Free plan (which has a strict 60-second limit). Instead, we let users configure the `timeout` parameter manually by appending `&timeout=300000` to their `BROWSERLESS_WS_ENDPOINT` environment variable on Vercel if their billing plan supports it.

---

## 🌐 8. Carrier Singleton Concurrency Hazard

### The Challenge
Initially, the carrier instances (`CARRIERS`) were instantiated once at the module level in `app/api/carriers/run/route.ts` and reused across all requests as singletons.
Since `BaseCarrier` stores the active Puppeteer `browser` and `currentSessionId` as instance properties, starting a new extraction session or retrying a failed session while another background promise was still executing would overwrite these properties. The old session would then accidentally run commands on the new session's browser, or the new session's browser would be closed prematurely when the old session's `finally` block called `closeBrowser()`. This caused transient `Session closed` and `detached Frame` errors.

### The Solution
We refactored `app/api/carriers/run/route.ts` to dynamically instantiate `AaaCarrier` or `LemonadeCarrier` **per request** instead of reusing global singletons. This isolates the browser context, session IDs, and Puppeteer commands entirely to each session run.

---

## 🌐 9. Free-Tier Limitations vs. Production Architecture

### The Challenge
When testing in free-tier environments, we hit strict, hard-capped timeout limits that make interactive MFA flows impossible to run reliably:
1. **Vercel Free Tier**: Enforces a strict **10-second execution limit** per serverless function, which is too short for logging in, waiting for user MFA, and downloading documents.
2. **Browserless.io Free Tier**: Restricts sessions to a maximum of **60 seconds (1 minute)** and rejects custom `timeout` parameters with a `400 Bad Request`. When a user takes time to retrieve and enter an MFA code, the session is terminated server-side mid-execution, causing Puppeteer to throw `detached Frame` or `Session closed` errors.

### The Solution
* **Paid Production Tiers**: The codebase is architected to run seamlessly on paid tiers (Vercel Pro + Paid Browserless.io), where the custom `timeout=300000` (5 minutes) parameter is accepted, and function durations are extended to accommodate human MFA retrieval.
* **100% Free Alternative (Docker/Raspberry Pi)**: For developers who want to avoid paid plans, containerizing the application using **Docker** and running it on a dedicated local machine (like a Raspberry Pi or home server) is the optimal path. The container runs a local Chromium browser internally (configured via `PUPPETEER_EXECUTABLE_PATH`), eliminating both Browserless and Vercel execution timeouts entirely while maintaining 100% production parity.