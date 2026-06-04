/**
 * Inspects Lemonade dashboard + policy tab DOM via Browserless.
 *
 * Step 1 — trigger MFA only (do not pass OTP):
 *   node scripts/inspect-lemonade-policy-tab.mjs <email>
 *   Wait for the code in your inbox, then run step 2.
 *
 * Step 2 — after you have the code:
 *   node scripts/inspect-lemonade-policy-tab.mjs <email> <otp>
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (!process.env[key]) {
        process.env[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env */
  }
}

const SELECTORS = {
  emailInput: "input[data-atn-id=\"email-input\"]",
  submitButton: "button[data-atn-id=\"submit-button\"]",
  otpInputs: "input[autocomplete=\"one-time-code\"]",
  policyCard: "div[class*=\"HomeExistingProductItem__Title\"]",
};

const LEMONADE_LOGIN_URL = "https://www.lemonade.com/login#email";
const NAV_TIMEOUT = 60_000;

function summarizeDom(html, url) {
  const classHits = [...html.matchAll(/class="([^"]{1,200})"/g)]
    .map((m) => m[1])
    .filter((c) =>
      /policy|Policy|Product|Home|Existing|Declaration|document|Document/i.test(c)
    )
    .slice(0, 40);

  const dataAtn = [...html.matchAll(/data-atn-id="([^"]+)"/g)].map((m) => m[1]);
  const uniqueAtn = [...new Set(dataAtn)];

  return { url, classHits, dataAtnIds: uniqueAtn.slice(0, 80) };
}

async function dumpPage(page, label) {
  const url = page.url();
  const html = await page.content();
  const summary = summarizeDom(html, url);
  const selectorProbe = await page.evaluate((candidates) => {
    const results = {};
    for (const sel of candidates) {
      try {
        results[sel] = document.querySelectorAll(sel).length;
      } catch (e) {
        results[sel] = `error: ${e.message}`;
      }
    }
    return results;
  }, [
    SELECTORS.policyCard,
    'div[class*="HomeExistingProductItem"]',
    'a[href*="/policy/"]',
    '[data-atn-id]',
    'main',
    '[role="main"]',
    'h1',
    'h2',
  ]);

  console.log(`\n=== ${label} ===`);
  console.log("URL:", url);
  console.log("Selector counts:", JSON.stringify(selectorProbe, null, 2));
  console.log("data-atn-id (sample):", summary.dataAtnIds.slice(0, 30));
  console.log("Interesting classes:", summary.classHits.slice(0, 20));
}

loadEnv();

const ws = process.env.BROWSERLESS_WS_ENDPOINT;
const email = process.argv[2];
const otp = process.argv[3];

if (!ws) {
  console.error("BROWSERLESS_WS_ENDPOINT missing");
  process.exit(1);
}
if (!email) {
  console.error("Usage: node scripts/inspect-lemonade-policy-tab.mjs <email> [otp]");
  process.exit(1);
}

const browser = await puppeteer.connect({ browserWSEndpoint: ws });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

try {
  await page.goto(LEMONADE_LOGIN_URL, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
  await page.waitForSelector(SELECTORS.emailInput, { visible: true, timeout: 30_000 });
  await page.type(SELECTORS.emailInput, email, { delay: 30 });
  await page.click(SELECTORS.submitButton);
  await page.waitForSelector(SELECTORS.otpInputs, { visible: true, timeout: 30_000 });

  if (!otp) {
    await dumpPage(page, "OTP screen (no OTP provided)");
    process.exit(0);
  }

  const digits = String(otp).replace(/\s/g, "").split("");
  const inputs = await page.$$(SELECTORS.otpInputs);
  for (let i = 0; i < Math.min(6, digits.length); i++) {
    await inputs[i].click();
    await inputs[i].type(digits[i], { delay: 50 });
  }

  await page.waitForSelector(SELECTORS.policyCard, {
    visible: true,
    timeout: NAV_TIMEOUT,
  });
  await dumpPage(page, "Dashboard after OTP");

  const newTabPromise = new Promise((resolve) => {
    page.browser().once("targetcreated", async (target) => {
      if (target.type() === "page") {
        resolve(await target.page());
      }
    });
  });

  await page.click(SELECTORS.policyCard);
  const policyPage = await Promise.race([
    newTabPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("No new tab within 30s")), 30_000)
    ),
  ]);

  if (!policyPage) throw new Error("policy tab missing");

  await policyPage.bringToFront();
  await policyPage.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});

  await dumpPage(policyPage, "Policy tab after click");

  const suggested = await policyPage.evaluate(() => {
    const picks = [];
    const atn = [...document.querySelectorAll("[data-atn-id]")].slice(0, 15);
    for (const el of atn) {
      picks.push(`[data-atn-id="${el.getAttribute("data-atn-id")}"]`);
    }
    const byClass = [...document.querySelectorAll("div[class]")]
      .map((el) => el.className)
      .filter((c) => typeof c === "string" && /Policy|policy|Declaration|ExistingProduct/i.test(c))
      .slice(0, 15);
    return { dataAtnSelectors: picks, policyLikeClasses: byClass };
  });

  console.log("\nSuggested policy-tab selectors:", JSON.stringify(suggested, null, 2));
} finally {
  await browser.disconnect();
}
