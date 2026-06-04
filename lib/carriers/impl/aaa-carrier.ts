import { Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { DocumentResult } from "../types";

// ─── Selectors ────────────────────────────────────────────────────────────────
// Defined as constants at the top so they're trivial to update if the AAA DOM changes.

const SELECTORS = {
  // Step 1 — Email
  emailInput:       "#username",
  continueButton:   "._button-login-id",

  // Step 2 — Password (appears after the UI transition)
  passwordInput:    "#password",
  signInButton:     "._button-login-password",

  // MFA screen
  mfaDeliveryOption: "button[data-mfa-type]",      // "Text me" / "Email me" trigger
  mfaCodeInput:      "#otpCode",                    // one-time code field
  mfaSubmitButton:   "._button-login-passcode",     // submit the code

  // Post-auth documents page
  documentLink:     "a[data-document-id]",          // individual doc download anchors
} as const;

const AAA_LOGIN_URL = "https://auth.mwg.aaa.com/u/login/identifier?state=hKFo2SBnZzBCOE5tYjhVZXZGX29hckt0M0g2d2E4N1NIcEVUUKFur3VuaXZlcnNhbC1sb2dpbqN0aWTZIFIyMTBSN2xmSVo0a0JHdkFkTGF1OUg2cFFaTm9XR1ZRo2NpZLRBQUEuQ0xVQi5DU0FBTVAuUFJPRA";

// Timeout for DOM transitions that are not navigation events (ms)
const DOM_TRANSITION_TIMEOUT = 15_000;
// Timeout for full-page navigations (ms)
const NAVIGATION_TIMEOUT     = 30_000;

// ─── AaaCarrier ───────────────────────────────────────────────────────────────

/**
 * AaaCarrier
 * ----------
 * Concrete extractor for the AAA member portal.
 *
 * Login flow (two-step SPA transition):
 *   1. Land on /login  →  enter email  →  click Continue
 *   2. Portal reveals the password field in-place (no full navigation)
 *      →  wait for #password to become visible  →  enter password  →  Sign In
 *
 * MFA flow:
 *   Portal always presents an MFA challenge after successful credential entry.
 *   `triggerMfa` clicks the user's preferred delivery method;
 *   `submitMfaInBrowser` fills and submits the code once the base class
 *   has collected it from Redis.
 */
export class AaaCarrier extends BaseCarrier {
  readonly carrierId = "aaa";

  // ─── Page Configuration ─────────────────────────────────────────────────────

  protected override async configurePage(page: Page): Promise<void> {
    // AAA's portal checks Accept-Language for localization
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // Override the navigation timeout set by the base class for this carrier
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(DOM_TRANSITION_TIMEOUT);
  }

  // ─── login() — required by BaseCarrier ──────────────────────────────────────

  /**
   * Orchestrates `navigateToLogin` → `submitCredentials`.
   * Maps onto the BaseCarrier contract; detailed logic lives in the helpers below.
   */
  protected async login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    const { email, password } = AaaCarrier.extractCredentials(credentials);

    await this.navigateToLogin(page);
    await this.submitCredentials(page, email, password);
  }

  // ─── Step 1: Navigate ────────────────────────────────────────────────────────

  /**
   * Navigates to the AAA login page and waits until the email input is ready.
   */
  private async navigateToLogin(page: Page): Promise<void> {
    await page.goto(AAA_LOGIN_URL, { waitUntil: "networkidle2" });

    await page.waitForSelector(SELECTORS.emailInput, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });
  }

  // ─── Step 2: Submit Credentials (two-step SPA flow) ─────────────────────────

  /**
   * Handles the two-step credential form:
   *
   *   Phase A  →  fill email  →  click Continue (no page navigation)
   *   Phase B  →  wait for #password to become visible  →  fill password  →  Sign In
   *
   * The portal swaps between phases via a CSS visibility toggle, not a navigation,
   * so we wait on `waitForSelector` with `state: 'visible'` rather than
   * `waitForNavigation`.
   */
  private async submitCredentials(
    page: Page,
    email: string,
    password: string
  ): Promise<void> {
    // ── Phase A: Email ──────────────────────────────────────────────────────────

    await page.waitForSelector(SELECTORS.emailInput, { visible: true });

    // Clear any pre-filled value before typing
    await page.evaluate(
      (sel) => ((document.querySelector(sel) as HTMLInputElement).value = ""),
      SELECTORS.emailInput
    );
    await page.type(SELECTORS.emailInput, email, { delay: 40 });

    await page.waitForSelector(SELECTORS.continueButton, { visible: true });
    await page.click(SELECTORS.continueButton);

    // ── Phase B: Password ───────────────────────────────────────────────────────

    // The Continue click hides the email phase and reveals the password phase
    // in-place; there is no navigation event to await, so we explicitly gate
    // on the password field becoming visible before typing.
    await page.waitForSelector(SELECTORS.passwordInput, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });

    await page.type(SELECTORS.passwordInput, password, { delay: 40 });

    await page.waitForSelector(SELECTORS.signInButton, { visible: true });

    // Sign In triggers a real navigation to the authenticated portal
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT }),
      page.click(SELECTORS.signInButton),
    ]);
  }

  // ─── triggerMfa() — required by BaseCarrier ─────────────────────────────────

  /**
   * Determines whether the portal has presented an MFA challenge.
   * AAA always requires MFA, but we still defensively check the DOM.
   *
   * Clicks the first available delivery-method button (e.g. "Text me a code")
   * to request the one-time code.
   */
  protected async triggerMfa(page: Page): Promise<void> {
    if (!(await this.requiresMfa(page))) {
      // No MFA screen — portal may have remembered this device; proceed directly.
      return;
    }

    // Select the first delivery option presented (SMS preferred over email
    // by DOM order on the AAA portal — adjust the selector if needed)
    await page.waitForSelector(SELECTORS.mfaDeliveryOption, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });
    await page.click(SELECTORS.mfaDeliveryOption);

    // Wait for the code input to appear, confirming the code was sent
    await page.waitForSelector(SELECTORS.mfaCodeInput, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });
  }

  // ─── submitMfaInBrowser() — required by BaseCarrier ─────────────────────────

  /**
   * Types the MFA code (sourced from Redis by the base class polling loop)
   * into the OTP field and submits it.
   */
  protected async submitMfaInBrowser(page: Page, code: string): Promise<void> {
    await page.waitForSelector(SELECTORS.mfaCodeInput, { visible: true });

    // OTP inputs are often single-character cells; `type` with a slight delay
    // ensures each keystroke registers in frameworks that listen per-character.
    await page.type(SELECTORS.mfaCodeInput, code, { delay: 60 });

    await page.waitForSelector(SELECTORS.mfaSubmitButton, { visible: true });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT }),
      page.click(SELECTORS.mfaSubmitButton),
    ]);
  }

  // ─── fetchDocuments() — required by BaseCarrier ──────────────────────────────

  protected async fetchDocuments(page: Page): Promise<DocumentResult["documents"]> {
    await page.goto("https://mywallet.acg.aaa.com/member-portal/documents", {
      waitUntil: "networkidle2",
      timeout:   NAVIGATION_TIMEOUT,
    });

    await page.waitForSelector(SELECTORS.documentLink, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });

    // Collect every (href, document-type, filename) tuple up-front
    const entries = await page.$$eval(SELECTORS.documentLink, (anchors) =>
      (anchors as HTMLAnchorElement[]).map((a) => ({
        href:     a.href,
        docType:  a.dataset.documentType ?? "UNKNOWN",
        filename: a.dataset.filename ?? a.href.split("/").pop() ?? "document",
      }))
    );

    const documents: DocumentResult["documents"] = [];

    for (const { href, docType, filename } of entries) {
      const response = await page.goto(href, {
        waitUntil: "networkidle2",
        timeout:   NAVIGATION_TIMEOUT,
      });

      if (!response?.ok()) {
        console.warn(`[aaa] Skipping ${filename} — HTTP ${response?.status()}`);
        continue;
      }

      const data     = Buffer.from(await response.buffer());
      const mimeType = response.headers()["content-type"] ?? "application/octet-stream";

      documents.push({ type: docType, filename, mimeType, data });
    }

    return documents;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Returns `true` when the MFA challenge screen is visible in the DOM.
   * Useful for portals that occasionally skip MFA for trusted devices.
   */
  private async requiresMfa(page: Page): Promise<boolean> {
    const element = await page.$(SELECTORS.mfaDeliveryOption);
    return element !== null;
  }

  /**
   * Validates and destructures credentials, giving clear errors on missing keys.
   */
  private static extractCredentials(
    credentials: Record<string, string>
  ): { email: string; password: string } {
    const { email, password } = credentials;

    if (!email)    throw new Error("AaaCarrier: missing credential 'email'");
    if (!password) throw new Error("AaaCarrier: missing credential 'password'");

    return { email, password };
  }
}
