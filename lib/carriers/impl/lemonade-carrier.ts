import { Browser, Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { DocumentResult } from "../types";

// ─── Selectors ────────────────────────────────────────────────────────────────
// Lemonade uses stable data-atn-id attributes rather than IDs or class names,
// which makes these selectors resilient to style/layout changes.

const SELECTORS = {
  // Login — email-only (passwordless)
  emailInput:    'input[data-atn-id="email-input"]',
  submitButton:  'button[data-atn-id="submit-button"]',

  // OTP screen — 6 discrete single-character inputs
  otpInputs:     'input[autocomplete="one-time-code"]',

  // Post-auth dashboard only — clickable policy card title (not present on me.lemonade.com/policy tabs).
  policyCard:    'div[class*="HomeExistingProductItem__Title"]',
} as const;

/** Lemonade auto-triggers the OTP immediately after email submit */
const OTP_INPUT_COUNT = 6;

const LEMONADE_LOGIN_URL  = "https://www.lemonade.com/login#email";
const LEMONADE_POLICY_URL_PATTERN = /^https:\/\/me\.lemonade\.com\/policy\//;

const DOM_TIMEOUT  = 20_000;
const NAV_TIMEOUT  = 30_000;

/** Lemonade stores consent in this cookie; setting it suppresses the banner. */
const COOKIE_BANNER_ACCEPTED = "_lmnd_cookie_banner_accepted";
const COOKIE_ENABLE = "_lmnd_enable_cookies";

// ─── LemonadeCarrier ──────────────────────────────────────────────────────────

/**
 * LemonadeCarrier
 * ---------------
 * Concrete extractor for Lemonade's member portal (renters / homeowners).
 *
 * Auth flow (passwordless OTP):
 * 1. Navigate to /login#email
 * 2. Fill email using data-atn-id attributes  →  click Submit
 * 3. Lemonade immediately sends the OTP — no explicit trigger needed
 * 4. Wait for 6 individual OTP inputs to appear
 * 5. Type each digit of the code into its own input field
 *
 * Document flow:
 * 1. Land on the dashboard after OTP
 * 2. Click the first policy card title (class*="HomeExistingProductItem__Title")
 * 3. Intercept the new tab opened by the click via browser().waitForTarget()
 * 4. Wait for the policy page to settle, then capture it as a PDF via page.pdf()
 */
export class LemonadeCarrier extends BaseCarrier {
  readonly carrierId = "lemonade";

  // ─── Page Configuration ───────────────────────────────────────────────────

  protected override async configurePage(page: Page): Promise<void> {
    page.setDefaultTimeout(DOM_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await LemonadeCarrier.seedCookieConsent(page);
  }

  // ─── login() — required by BaseCarrier ───────────────────────────────────

  /**
   * Lemonade is passwordless: login only requires an email address.
   * Orchestrates `MapsToLogin` → `submitCredentials`.
   */
  protected async login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    const email = LemonadeCarrier.extractEmail(credentials);

    await this.navigateToLogin(page);
    await this.submitCredentials(page, email);
    await this.progress(
      "Check your email — Lemonade sent a 6-digit code to complete sign-in"
    );
  }

  // ─── Step 1: Navigate ─────────────────────────────────────────────────────

  private async navigateToLogin(page: Page): Promise<void> {
    await this.progress("Opening Lemonade sign-in…");
    await page.goto(LEMONADE_LOGIN_URL, { waitUntil: "networkidle2" });
    await LemonadeCarrier.dismissCookieBanner(page);

    await this.progress("Preparing email sign-in form…");
    await page.waitForSelector(SELECTORS.emailInput, {
      visible: true,
      timeout: DOM_TIMEOUT,
    });
  }

  // ─── Step 2: Submit Email ─────────────────────────────────────────────────

  /**
   * Fills the email field and clicks Submit.
   * No password field — Lemonade's portal transitions directly to the OTP screen.
   */
  private async submitCredentials(page: Page, email: string): Promise<void> {
    await this.progress("Submitting your email…");
    await page.evaluate(
      (sel) => ((document.querySelector(sel) as HTMLInputElement).value = ""),
      SELECTORS.emailInput
    );
    await page.type(SELECTORS.emailInput, email, { delay: 40 });

    await page.waitForSelector(SELECTORS.submitButton, { visible: true });
    await page.click(SELECTORS.submitButton);

    await this.progress("Waiting for email verification screen…");
    await page.waitForSelector(SELECTORS.otpInputs, {
      visible: true,
      timeout: DOM_TIMEOUT,
    });
  }

  // ─── detectMfa() — required by BaseCarrier ───────────────────────────────

  /**
   * Lemonade triggers the OTP automatically when the email is submitted.
   * OTP inputs on screen mean we should pause for the user code.
   */
  protected override signInStatusMessage(): string {
    return "Signing in to Lemonade with your email…";
  }

  protected override postSignInCheckMessage(): string {
    return "Waiting for your email verification code…";
  }

  protected override navigateToDocumentsMessage(): string {
    return "Loading your Lemonade policies…";
  }

  protected override postNavigationCheckMessage(): string {
    return "Confirming sign-in is complete…";
  }

  protected override fetchDocumentsMessage(): string {
    return "Downloading your Lemonade policy PDF…";
  }

  protected override mfaAwaitingMessage(round: number): string {
    return round === 0
      ? "Enter the 6-digit code from your email"
      : `Enter the new 6-digit code from your email (step ${round + 1})`;
  }

  protected async detectMfa(page: Page): Promise<boolean> {
    const inputs = await page.$$(SELECTORS.otpInputs);
    if (inputs.length >= OTP_INPUT_COUNT) {
      return true;
    }

    try {
      await page.waitForSelector(SELECTORS.otpInputs, {
        visible: true,
        timeout: 3_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ─── navigateToDocumentsArea() — required by BaseCarrier ───────────────

  /** After OTP, wait for the dashboard policy list (no extra URLs to open). */
  protected async navigateToDocumentsArea(page: Page): Promise<void> {
    await this.progress("Loading your Lemonade dashboard…");
    await page.waitForSelector(SELECTORS.policyCard, {
      visible: true,
      timeout: DOM_TIMEOUT,
    });
    await LemonadeCarrier.dismissCookieBanner(page);
  }

  // ─── submitMfaInBrowser() — required by BaseCarrier ──────────────────────

  /**
   * Distributes the 6-digit OTP code across Lemonade's individual digit inputs.
   *
   * Each input accepts exactly one character. Typing the full code into the
   * first field does not work — the portal listens to individual `input` events
   * per cell and does not relay characters to subsequent inputs automatically.
   */
  protected override async afterMfaSubmit(page: Page): Promise<void> {
    await this.progress("Verifying code — loading your dashboard…");
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT })
      .catch(() => {});
  }

  protected async submitMfaInBrowser(page: Page, code: string): Promise<void> {
    await this.progress("Entering your email verification code…");
    // Upstash Redis auto-deserializes values that look like numbers into actual
    // Number types. An all-digit OTP like "123456" comes back as 123456, which
    // has no .replace() method. String() normalises either type safely.
    const digits = String(code).replace(/\s/g, "").split("");

    if (digits.length !== OTP_INPUT_COUNT) {
      throw new Error(
        `LemonadeCarrier: OTP must be ${OTP_INPUT_COUNT} digits, got ${digits.length}`
      );
    }

    // Re-query inputs at submission time to get a fresh NodeList after any
    // React re-renders that may have replaced DOM nodes since detectMfa.
    const inputs = await page.$$(SELECTORS.otpInputs);

    if (inputs.length < OTP_INPUT_COUNT) {
      throw new Error(
        `LemonadeCarrier: Expected ${OTP_INPUT_COUNT} OTP inputs, found ${inputs.length}`
      );
    }

    for (let i = 0; i < OTP_INPUT_COUNT; i++) {
      await inputs[i].click();
      await inputs[i].type(digits[i], { delay: 60 });
    }
  }

  // ─── fetchDocuments() — required by BaseCarrier ──────────────────────────

  /**
   * Navigates to the first policy card on the dashboard and captures the
   * declarations page as a PDF buffer using page.pdf().
   *
   * The policy page at https://me.lemonade.com/policy/[POLICY_ID] acts as
   * the declarations page — we treat the full-page PDF as the document.
   */
  protected async fetchDocuments(page: Page): Promise<DocumentResult["documents"]> {
    await this.progress("Selecting your policy…");
    await page.waitForSelector(SELECTORS.policyCard, {
      visible: true,
      timeout: DOM_TIMEOUT,
    });
    await LemonadeCarrier.dismissCookieBanner(page);

    await this.progress("Opening policy declarations page…");

    // Intercept window.open so we can capture the URL the policy card would
    // open in a new tab, then navigate the MAIN page there instead.
    //
    // Browserless assigns a very short lifetime to popup/child tabs — they are
    // often reaped before Page.printToPDF can finish. By staying on the primary
    // session page we avoid that problem entirely.
    let capturedPolicyUrl: string | null = null;
    await page.exposeFunction("__lmndCaptureOpen", (url: string) => {
      capturedPolicyUrl = url;
    });
    await page.evaluate(() => {
      window.open = (url?: string | URL) => {
        if (url) (window as any).__lmndCaptureOpen(url.toString());
        return null;
      };
    });

    await page.click(SELECTORS.policyCard);

    // Give the click handler up to 5 s to call window.open
    const openDeadline = Date.now() + 5_000;
    while (!capturedPolicyUrl && Date.now() < openDeadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (!capturedPolicyUrl) {
      throw new Error("LemonadeCarrier: window.open did not fire — no URL captured within 5s");
    }

    // Lemonade calls window.open with a relative path like "/policy/LP4C963AC88".
    // Resolve it to the absolute me.lemonade.com URL before navigating.
    const rawUrl = capturedPolicyUrl as string;
    const policyUrl = rawUrl.startsWith("/")
      ? `https://me.lemonade.com${rawUrl}`
      : rawUrl;

    if (!LEMONADE_POLICY_URL_PATTERN.test(policyUrl)) {
      throw new Error(
        `LemonadeCarrier: Unexpected policy URL: ${policyUrl}`
      );
    }
    const policyId = policyUrl.split("/policy/")[1]?.split("?")[0] ?? "unknown";

    await this.progress("Loading policy declarations page…");

    // Navigate the main page (primary Browserless session) directly to the policy URL.
    await page.goto(policyUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });

    // Wait for the policy page to finish rendering (SPA data-loading guard).
    await page
      .waitForFunction(
        () => !document.querySelector('[data-loading="true"]'),
        { timeout: DOM_TIMEOUT }
      )
      .catch(() => {});

    await this.progress("Finding policy download link…");

    // Lemonade renders an <a download href="https://icebox.lemonade.com/tokens/…">
    // link on the policy page. That URL is a signed token that returns the raw PDF
    // directly — far more reliable than Page.printToPDF against a live SPA.
    const downloadHref = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLAnchorElement>("a[download][href]");
      return anchor?.href ?? null;
    });

    if (!downloadHref || !downloadHref.includes("icebox.lemonade.com")) {
      throw new Error(
        `LemonadeCarrier: Could not find signed download link on policy page (found: ${downloadHref ?? "nothing"})`
      );
    }

    await this.progress("Downloading policy PDF…");

    // icebox.lemonade.com blocks cross-origin fetch() from the browser (CORS).
    // Instead, extract the browser's cookies and make the request from Node.js,
    // which has no CORS restrictions.
    const allCookies = await page.cookies();
    const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join("; ");

    const pdfResponse = await fetch(downloadHref, {
      headers: {
        "Cookie":     cookieHeader,
        "User-Agent": await page.evaluate(() => navigator.userAgent),
        "Referer":    policyUrl,
      },
      redirect: "follow",
    });

    if (!pdfResponse.ok) {
      throw new Error(
        `LemonadeCarrier: Download request failed — ${pdfResponse.status} ${pdfResponse.statusText}`
      );
    }

    const pdfData = Buffer.from(await pdfResponse.arrayBuffer());

    return [
      {
        type:     "DECLARATIONS",
        filename: `lemonade-policy-${policyId}.pdf`,
        mimeType: "application/pdf",
        data:     pdfData,
      },
    ];
  }



  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * The policy SPA may open as about:blank then redirect; the initial Target's
   * Page can detach. Poll open tabs for a stable me.lemonade.com/policy URL.
   */
  /** Pre-set consent so the OneTrust-style banner never mounts on new navigations. */
  private static async seedCookieConsent(page: Page): Promise<void> {
    const base = {
      path: "/",
      secure: true,
      sameSite: "Lax" as const,
    };
    for (const domain of [".lemonade.com", "me.lemonade.com", "www.lemonade.com"]) {
      await page
        .setCookie(
          { ...base, name: COOKIE_BANNER_ACCEPTED, value: "true", domain },
          { ...base, name: COOKIE_ENABLE, value: "true", domain }
        )
        .catch(() => {});
    }
  }

  /**
   * Clicks "Reject all" or "Accept all" if the banner is already visible.
   * Either choice dismisses the modal before printToPDF.
   */
  private static async dismissCookieBanner(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      for (const label of ["Reject all", "Accept all"]) {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === label
        );
        if (btn) {
          (btn as HTMLButtonElement).click();
          return label;
        }
      }
      return null;
    });

    if (!clicked) return;

    await page
      .waitForFunction(
        () =>
          ![...document.querySelectorAll("h3")].some((h) =>
            /lemonade and cookies/i.test(h.textContent ?? "")
          ),
        { timeout: 5_000 }
      )
      .catch(() => {});
  }

  /**
   * Fixed cookie CMPs reappear on every printed PDF page. Click-dismiss is not
   * enough — remove overlay nodes and inject print-hiding CSS before pdf().
   */
  private static async preparePolicyPageForPdf(page: Page): Promise<void> {
    await LemonadeCarrier.seedCookieConsent(page);
    await LemonadeCarrier.dismissCookieBanner(page);

    await page.evaluate(() => {
      const isCookieText = (text: string) =>
        /lemonade and cookies|cookie consent|cookies policy|tracking technologies/i.test(
          text
        );

      const hideSubtree = (root: HTMLElement) => {
        root.style.display = "none";
        root.style.visibility = "hidden";
      };

      // Walk headings first — Lemonade's banner is anchored on "lemonade and cookies".
      for (const heading of document.querySelectorAll("h2, h3, h4")) {
        if (!isCookieText(heading.textContent ?? "")) continue;
        let el: Element | null = heading;
        for (let depth = 0; depth < 15 && el; depth++) {
          const node = el as HTMLElement;
          const style = window.getComputedStyle(node);
          if (
            style.position === "fixed" ||
            style.position === "sticky" ||
            node.getAttribute("role") === "dialog" ||
            depth >= 8
          ) {
            hideSubtree(node);
            break;
          }
          el = el.parentElement;
        }
      }

      const cmpSelectors = [
        "#onetrust-consent-sdk",
        "#onetrust-banner-sdk",
        ".onetrust-pc-dark-filter",
        "#ot-sdk-btn-floating",
        '[id^="onetrust"]',
        '[class*="onetrust" i]',
      ];
      for (const sel of cmpSelectors) {
        try {
          document.querySelectorAll(sel).forEach((n) => hideSubtree(n as HTMLElement));
        } catch {
          /* invalid selector in older engines */
        }
      }

      // Any fixed/sticky layer that still mentions cookies.
      document.querySelectorAll("*").forEach((el) => {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        if (style.position !== "fixed" && style.position !== "sticky") return;
        const text = html.innerText ?? "";
        if (text.length > 4_000) return;
        if (isCookieText(text)) hideSubtree(html);
      });
    });

    await page.addStyleTag({
      content: `
        #onetrust-consent-sdk,
        #onetrust-banner-sdk,
        .onetrust-pc-dark-filter,
        [id^="onetrust"] {
          display: none !important;
          visibility: hidden !important;
        }
        @media print {
          #onetrust-consent-sdk,
          #onetrust-banner-sdk,
          .onetrust-pc-dark-filter,
          [id^="onetrust"],
          [role="dialog"] {
            display: none !important;
            visibility: hidden !important;
          }
        }
      `,
    });

    await new Promise((r) => setTimeout(r, 500));
  }



  private static extractEmail(credentials: Record<string, string>): string {
    if (!credentials.email) {
      throw new Error("LemonadeCarrier: missing credential 'email'");
    }
    return credentials.email;
  }
}