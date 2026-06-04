import { Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { DocumentResult } from "../types";

// ─── Selectors ────────────────────────────────────────────────────────────────
const SELECTORS = {
  // Step 1 — Auth
  emailInput:        'input[name="username"]',
  continueButton:    'button[data-action-button-primary="true"]',
  passwordInput:     'input[name="password"]',
  signInButton:      'button._button-login-password',

  // Step 2 — Dashboard Navigation
  insuranceLink:     'a[href="/my-account/insurance"]',
  policyDocsLink:    'a[href*="documents"]',

  // Okta MFA screen
  oktaSendCode:      'input[value="Send me the code"]',
  mfaInput:          'input[name="answer"]',
  mfaVerify:         'input[value="Verify"]',

  // Dashboard Target
  dashboardText:     'p.MuiTypography-body1',
  policyDetailsBtn:  'a[data-testid^="view-policy-details-button-"]',
  declarationsChip:  'span.MuiChip-labelMedium'
} as const;

// Timeout for DOM transitions that are not navigation events (ms)
const DOM_TRANSITION_TIMEOUT = 15_000;
// Timeout for full-page navigations (ms)
const NAVIGATION_TIMEOUT     = 30_000;

// ─── AaaCarrier ───────────────────────────────────────────────────────────────

export class AaaCarrier extends BaseCarrier {
  readonly carrierId = "aaa";
  
  // Tracks the active tab context since AAA opens multiple windows during the flow
  private activeTab: Page | null = null;

  // ─── Page Configuration ─────────────────────────────────────────────────────

  protected override async configurePage(page: Page): Promise<void> {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(DOM_TRANSITION_TIMEOUT);
  }

  // ─── login() — required by BaseCarrier ──────────────────────────────────────

  protected async login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    const { email, password } = AaaCarrier.extractCredentials(credentials);

    await page.goto("https://mwg.aaa.com/my-account/insurance", { waitUntil: "networkidle2" });

    await page.waitForSelector(SELECTORS.emailInput, { visible: true });
    
    // Clear any pre-filled value before typing
    await page.evaluate(
      (sel) => ((document.querySelector(sel) as HTMLInputElement).value = ""),
      SELECTORS.emailInput
    );
    await page.type(SELECTORS.emailInput, email, { delay: 40 });

    await page.waitForSelector(SELECTORS.continueButton, { visible: true });
    await page.click(SELECTORS.continueButton);

    // The Continue click hides the email phase and reveals the password phase
    await page.waitForSelector(SELECTORS.passwordInput, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });

    await page.type(SELECTORS.passwordInput, password, { delay: 40 });
    await page.waitForSelector(SELECTORS.signInButton, { visible: true });
    await page.click(SELECTORS.signInButton);
  }

  // ─── triggerMfa() — required by BaseCarrier ─────────────────────────────────

  protected async triggerMfa(page: Page): Promise<boolean> {
    await page.waitForSelector(SELECTORS.insuranceLink, { visible: true, timeout: NAVIGATION_TIMEOUT });
    await page.click(SELECTORS.insuranceLink);

    // Native Tab Intercept for Policy Documents (First New Tab)
    const newTargetPromise = new Promise<Page>((resolve) => {
      page.browser().once("targetcreated", async (target) => resolve(await target.page() as Page));
    });

    await page.waitForSelector(SELECTORS.policyDocsLink, { visible: true });
    await page.click(SELECTORS.policyDocsLink);

    const newPage = await newTargetPromise;
    this.activeTab = newPage; // Store the new tab context for subsequent steps

    console.log(`[aaa] Evaluating AAA Okta MFA race...`);
    
    // Race condition: Okta MFA wall vs Direct Dashboard Access
    const raceResult = await Promise.race([
      newPage.waitForSelector(SELECTORS.oktaSendCode, { visible: true, timeout: 15000 }).then(() => 'mfa'),
      newPage.waitForFunction(
        (sel) => document.querySelector(sel)?.textContent?.includes('View policies'),
        { timeout: 15000 },
        SELECTORS.dashboardText
      ).then(() => 'dashboard')
    ]);

    if (raceResult === 'mfa') {
      await newPage.click(SELECTORS.oktaSendCode);
      return true;
    }
    
    return false;
  }

  // ─── submitMfaInBrowser() — required by BaseCarrier ─────────────────────────

  protected async submitMfaInBrowser(page: Page, code: string): Promise<void> {
    const targetPage = this.activeTab || page;
    const safeCode = String(code).replace(/\s/g, "");

    await targetPage.waitForSelector(SELECTORS.mfaInput, { visible: true });
    await targetPage.type(SELECTORS.mfaInput, safeCode, { delay: 60 });
    await targetPage.click(SELECTORS.mfaVerify);
  }

  // ─── fetchDocuments() — required by BaseCarrier ──────────────────────────────

  protected async fetchDocuments(page: Page): Promise<DocumentResult["documents"]> {
    const targetPage = this.activeTab || page;

    // Ensure we are successfully on the dashboard view
    await targetPage.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.includes('View policies'),
      {},
      SELECTORS.dashboardText
    );

    await targetPage.waitForSelector(SELECTORS.policyDetailsBtn, { visible: true });
    await targetPage.click(SELECTORS.policyDetailsBtn);

    // Native Tab Intercept for Final PDF (Second New Tab)
    const pdfTargetPromise = new Promise<Page>((resolve) => {
      targetPage.browser().once("targetcreated", async (target) => resolve(await target.page() as Page));
    });

    await targetPage.waitForSelector(SELECTORS.declarationsChip, { visible: true });
    
    // Use evaluate to guarantee we click the exact span containing the correct text
    await targetPage.evaluate((sel) => {
      const elements = Array.from(document.querySelectorAll(sel));
      const target = elements.find(el => el.textContent?.includes('Policy declarations')) as HTMLElement;
      if (target) target.click();
    }, SELECTORS.declarationsChip);

    const pdfPage = await pdfTargetPromise;
    
    // Wait for the browser to render the PDF buffer internally
    await pdfPage.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {});

    const pdfBytes = await pdfPage.pdf({ format: "A4" });

    return [{
      type: "policy",
      filename: "policy-declarations.pdf",
      mimeType: "application/pdf",
      data: Buffer.from(pdfBytes)
    }];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private static extractCredentials(
    credentials: Record<string, string>
  ): { email: string; password: string } {
    const { email, password } = credentials;

    if (!email)    throw new Error("AaaCarrier: missing credential 'email'");
    if (!password) throw new Error("AaaCarrier: missing credential 'password'");

    return { email, password };
  }
}