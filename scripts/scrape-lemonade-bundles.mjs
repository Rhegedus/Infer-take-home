/**
 * Downloads Lemonade JS chunks via Browserless and searches for DOM hints.
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
      if (!process.env[key]) process.env[key] = val.replace(/^["']|["']$/g, "");
    }
  } catch {}
}

loadEnv();
const ws = process.env.BROWSERLESS_WS_ENDPOINT;
const browser = await puppeteer.connect({ browserWSEndpoint: ws });
const page = await browser.newPage();

const jsBodies = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!url.includes(".js")) return;
  try {
    const text = await res.text();
    if (text.length > 5000) jsBodies.push({ url, text });
  } catch {}
});

const targets = [
  "https://www.lemonade.com/login#email",
  "https://me.lemonade.com/",
];
for (const target of targets) {
  console.log("\n### Navigating to", target);
  await page.goto(target, { waitUntil: "networkidle2", timeout: 60_000 }).catch((e) =>
    console.log("goto error:", e.message)
  );
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 3000));

const patterns = [
  "HomeExistingProductItem",
  "ExistingProduct",
  "policy",
  "PolicyPage",
  "data-atn-id",
  "declarations",
];

for (const { url, text } of jsBodies) {
  for (const p of patterns) {
    if (!text.includes(p)) continue;
    const idx = text.indexOf(p);
    console.log("\n---", p, "in", url.slice(0, 120), "---");
    console.log(text.slice(Math.max(0, idx - 80), idx + 200));
  }
}

console.log("\nTotal JS responses captured:", jsBodies.length);
await browser.disconnect();
