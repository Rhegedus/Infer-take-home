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

## 🍋 2. Lemonade: SPA Target/Tab Interception & PrintToPDF Failures

### The Challenge
Lemonade opens the policy PDF in a new tab. In headless mode, if we tried to print the page to PDF (`page.pdf()`), it would frequently throw `printToPDF: Target closed` due to the tab loading asynchronously or the document closing too quickly.

### The Solution
* We set up a target listener (`browser.waitForTarget`) to intercept the newly opened tab as soon as the "View Policy" action is triggered.
* Once the tab is acquired, instead of rendering a PDF printout, we extract the browser's cookies and perform a standard Node.js `fetch` to download the document.
* We stripped out fixed consent overlays and cookie banners programmatically before extraction to prevent visual blocking.

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
