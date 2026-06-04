# DocExtract: Personal Lines Insurance Scraper

A production-ready, serverless-first web application designed to securely authenticate, navigate MFA, and extract policy declaration documents from personal lines insurance carriers.

**Watch the Demo:** [Link to your Loom Video]
**Claude Session Transcripts:** [Link to Claude Session 1] | [Link to Claude Session 2]

## 🏗️ Architecture & System Design

This project is architected specifically to run in ephemeral, serverless environments (like Vercel) rather than relying on a local machine's persistent state. 

* **Next.js (App Router):** Handles the frontend UI and serverless API routes.
* **Browserless.io (WebSocket):** Offloads the headless Chrome execution. Running Puppeteer directly in a Vercel serverless function is unstable due to binary size limits and memory constraints. Browserless ensures a scalable, isolated browser environment.
* **Upstash Redis:** Acts as the central nervous system. 
    * **State Machine:** Serverless API routes cannot hold long-polling connections open indefinitely. The architecture uses an asynchronous background execution model that updates session state in Redis. The frontend polls a lightweight `GET` route to track progress (e.g., `AWAITING_MFA`, `FETCHING_DOCS`).
    * **Ephemeral Document Store:** Serverless environments have read-only file systems. Extracted PDFs are temporarily stored in Redis as Base64 strings with a strict TTL, completely avoiding the local disk before being served to the client.

## 🛡️ Fingerprinting, Anti-Bot, & Reliability

Navigating carrier portals requires balancing speed with bot-detection evasion. 

* **Real User Emulation (Tab Interception):** Rather than attempting raw API intercepts or programmatic direct navigations (which often lack the necessary client-side state or tokens), the extraction mimics human behavior. For example, the Lemonade carrier natively catches SPA window targets (`browser.waitForTarget`) to capture documents that open in new tabs, preventing layout shift timeouts.
* **Stealth vs. Speed Tradeoffs:** The headless browser utilizes standard Puppeteer Stealth plugins provided by the Browserless infrastructure. 
    * *Tradeoff:* While residential proxies (like BrightData) provide the highest success rate against strict Akamai/Cloudflare bot protections, they introduce significant latency. I opted for data center IPs via Browserless to meet the strict <8-second execution requirement, ensuring the UI remains highly responsive.
* **Session Reuse:** Upstash Redis handles TTL-based session storage. If a user drops off during the MFA challenge, the session state is preserved until timeout, preventing duplicate headless browser instances from spawning and rate-limiting the carrier account.

## 🚀 Supported Carriers

1.  **AAA:** Standard credentials (Email/Password) -> SMS MFA Challenge -> Document PDF.
2.  **Lemonade:** Passwordless flow (Email only) -> Automatic Email OTP Challenge -> SPA Tab Interception -> Document PDF.

## 💻 Running Locally

### 1. Environment Variables
Create a `.env.local` file in the root directory:

```env
# Browserless WebSocket endpoint (include your ?token=)
BROWSERLESS_WS_ENDPOINT="wss://chrome.browserless.io?token=YOUR_TOKEN"

# Upstash Redis REST credentials
UPSTASH_REDIS_REST_URL="[https://your-upstash-url.upstash.io](https://your-upstash-url.upstash.io)"
UPSTASH_REDIS_REST_TOKEN="your_upstash_token"
```

### 2. Install & Run
```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the UI.
