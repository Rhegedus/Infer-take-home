import { Browser, ElementHandle, Frame, Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { CarrierState, DocumentResult } from "../types";

// ─── URLs (manual flow reference) ─────────────────────────────────────────────
const MWG_INSURANCE_URL =
  "https://mwg.aaa.com/my-account/insurance";
const POLICY_CLUB_POLICIES_URL =
  "https://mypolicyclub.digital.csaa-insurance.aaa.com/policies";

// ─── Selectors ────────────────────────────────────────────────────────────────
const SELECTORS = {
  emailInput: "input[name=\"username\"]",
  continueButton: 'button[data-action-button-primary="true"]',
  passwordInput: 'input[name="password"]',
  signInButton: "button._button-login-password",
  insuranceLink:
    'a[href="/my-account/insurance"], a[data-discover="true"][href="/my-account/insurance"]',
  managePolicyLink:
    'a[href*="mypolicyclub"][href*="/policies"], a[href*="csaa-insurance.aaa.com"][href*="/policies"], a.link-text-arrow[href*="/policies"], a[target="_blank"][href*="/policies"]',
  oktaSendCode: 'input[value="Send me the code"]',
  mfaInput: 'input[name="answer"]',
  mfaVerify: 'input[value="Verify"]',
  dashboardText: "p.MuiTypography-body1",
  policyDetailsBtn: 'a[data-testid^="view-policy-details-button-"]',
  declarationsChip: "span.MuiChip-labelMedium",
} as const;

const OKTA_SEND_CODE_SELECTORS = [
  SELECTORS.oktaSendCode,
  'input[data-type="save"][value="Send me the code"]',
] as const;

const OKTA_INPUT_SELECTORS = [
  SELECTORS.mfaInput,
  'input[type="tel"][name="answer"]',
  'input[name="credentials.passcode"]',
  'input[autocomplete="one-time-code"]',
  '[data-se="o-form-input-passcode"] input',
  '[data-se="o-form-input-credentials.passcode"] input',
  ".okta-form-input-field input",
] as const;

const OKTA_VERIFY_SELECTORS = [
  SELECTORS.mfaVerify,
  'input[data-type="save"][value="Verify"]',
] as const;

const OKTA_HOST_URL = /\.okta\.com/i;
const POLICY_CLUB_URL = /csaa-insurance\.aaa\.com|mypolicyclub/i;

const DOM_TRANSITION_TIMEOUT = 15_000;
const NAVIGATION_TIMEOUT = 30_000;
const OKTA_SUBMIT_TIMEOUT = 45_000;
const TOTAL_STEPS = 6;

const OKTA_PASSCODE_SELECTOR =
  '#okta-sign-in input[name="answer"], input[name="answer"], input[type="tel"][name="answer"], input[name="credentials.passcode"]';

const OKTA_VERIFY_BUTTON_SELECTOR =
  '#okta-sign-in input.button.button-primary[value="Verify"], input.button-primary[value="Verify"], input[value="Verify"][data-type="save"]';

/** Okta widget loaded — send-code screen OR passcode screen (not the passcode field alone). */
const OKTA_WIDGET_SELECTOR =
  '#okta-sign-in, #signin-container, input[value="Send me the code"], input[data-type="save"][value="Send me the code"]';

type OktaDomContext = Page | Frame;
type OktaNeed = "send-code" | "verify-input";

interface OktaLoc {
  page: Page;
  context: OktaDomContext;
  send?: ElementHandle<Element>;
  input?: ElementHandle<Element>;
  verify?: ElementHandle<Element>;
}

/**
 * AAA extraction — explicit linear steps (no probe / navigation loops).
 *
 * 1. MWG sign-in (email → continue → password → sign in)
 * 2. Insurance account page
 * 3. Policy Club (/policies) via Manage Policy
 * 4. Okta email MFA (send code → enter code → verify) — skipped if already on dashboard
 * 5. Policy dashboard (www.mypolicy…/policies)
 * 6. Policy declarations PDF
 */
export class AaaCarrier extends BaseCarrier {
  readonly carrierId = "aaa";

  private mwgPage: Page | null = null;
  private policyClubPage: Page | null = null;
  private oktaPage: Page | null = null;

  protected override resetCarrierState(): void {
    this.mwgPage = null;
    this.policyClubPage = null;
    this.oktaPage = null;
  }

  protected override async configurePage(page: Page): Promise<void> {
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(DOM_TRANSITION_TIMEOUT);
  }

  protected override mfaAwaitingMessage(_round: number): string {
    return "Step 4/6: Enter the verification code sent to your email";
  }

  // ─── Linear pipeline (replaces generic MFA / navigation loops) ───────────────

  protected override async runPipeline(
    sessionId: string,
    credentials: Record<string, string>
  ): Promise<DocumentResult> {
    this.resetCarrierState();

    await this.progress("Launching secure browser…");
    const page = await this.openBrowser();

    await this.runStep(1, "Sign in on MWG (email → continue → password → sign in)", () =>
      this.stepMwgSignIn(page, credentials)
    );

    await this.runStep(2, "Open Insurance (/my-account/insurance)", () =>
      this.stepMwgInsurance(page)
    );

    await this.runStep(3, "Open Policy Club (Manage Policy → /policies)", () =>
      this.stepOpenPolicyClub(page)
    );

    await this.runStep(4, "Okta email verification (if required)", () =>
      this.stepOktaEmailMfa(sessionId, page)
    );

    await this.runStep(5, "Wait for policy dashboard", () =>
      this.stepWaitPolicyDashboard(page)
    );

    await this.progress(`Step ${TOTAL_STEPS}/${TOTAL_STEPS}: Download policy declarations`);
    const documents = await this.fetchDocumentsWithTransition(sessionId, page);
    return this.finalizeDocuments(sessionId, documents);
  }

  // ─── BaseCarrier stubs (pipeline is overridden) ─────────────────────────────

  protected async login(): Promise<void> {}
  protected async detectMfa(): Promise<boolean> {
    return false;
  }
  protected async navigateToDocumentsArea(): Promise<void> {}
  protected async submitMfaInBrowser(): Promise<void> {}

  // ─── Step 1: MWG sign-in ────────────────────────────────────────────────────

  private async stepMwgSignIn(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    const { email, password } = AaaCarrier.extractCredentials(credentials);

    await page.goto(MWG_INSURANCE_URL, { waitUntil: "domcontentloaded" });
    this.mwgPage = page;

    const needsLogin = await page
      .waitForSelector(SELECTORS.emailInput, { visible: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!needsLogin) return;

    await page.waitForSelector(SELECTORS.emailInput, { visible: true });
    await page.type(SELECTORS.emailInput, email, { delay: 40 });
    await page.click(SELECTORS.continueButton);

    await page.waitForSelector(SELECTORS.passwordInput, {
      visible: true,
      timeout: DOM_TRANSITION_TIMEOUT,
    });
    await page.type(SELECTORS.passwordInput, password, { delay: 40 });

    await Promise.all([
      page
        .waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT,
        })
        .catch(() => {}),
      page.click(SELECTORS.signInButton),
    ]);
  }

  // ─── Step 2: Insurance ────────────────────────────────────────────────────────

  private async stepMwgInsurance(page: Page): Promise<void> {
    const mwg = this.mwgPage ?? page;

    if (await AaaCarrier.isMwgInsuranceReady(mwg)) return;

    const hasInsuranceNav = await mwg
      .waitForSelector(SELECTORS.insuranceLink, { visible: true, timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (hasInsuranceNav) {
      await this.progress("Step 2/6: Clicking Insurance in account menu…");
      await mwg.click(SELECTORS.insuranceLink);
      await mwg
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT })
        .catch(() => {});
      if (await AaaCarrier.isMwgInsuranceReady(mwg)) return;
    }

    await this.progress("Step 2/6: Opening Insurance page directly…");
    await mwg.goto(MWG_INSURANCE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    await AaaCarrier.waitForMwgInsuranceReady(mwg, NAVIGATION_TIMEOUT);
  }

  // ─── Step 3: Policy Club ────────────────────────────────────────────────────

  private async stepOpenPolicyClub(page: Page): Promise<void> {
    const mwg = this.mwgPage ?? page;
    const browser = mwg.browser();

    await this.progress("Step 3/6: Finding Manage Policy link…");
    const href = await AaaCarrier.resolveManagePolicyHref(mwg);

    await mwg.waitForSelector(SELECTORS.managePolicyLink, {
      visible: true,
      timeout: NAVIGATION_TIMEOUT,
    });

    const pagesBefore = await AaaCarrier.safeBrowserPages(browser);

    await this.progress("Step 3/6: Clicking Manage Policy…");
    await mwg.click(SELECTORS.managePolicyLink).catch(() => {});

    let clubTab = await AaaCarrier.waitForNewPolicyClubTab(
      browser,
      pagesBefore,
      10_000
    );

    if (!clubTab) {
      await this.progress("Step 3/6: Opening policies URL directly…");
      clubTab = await browser.newPage();
      await AaaCarrier.navigatePolicyClubTab(clubTab, href);
    } else {
      await this.progress("Step 3/6: Waiting for Policy Club to load…");
      await AaaCarrier.waitForTabReachAuth(clubTab, NAVIGATION_TIMEOUT);
    }

    this.policyClubPage = clubTab;

    const oktaTab = await AaaCarrier.findOktaTab(browser);
    if (oktaTab) this.oktaPage = oktaTab;
    else if (OKTA_HOST_URL.test(AaaCarrier.safeUrl(clubTab))) {
      this.oktaPage = clubTab;
    }
  }

  // ─── Step 4: Okta MFA ───────────────────────────────────────────────────────

  private async stepOktaEmailMfa(sessionId: string, page: Page): Promise<void> {
    const browser = (this.mwgPage ?? page).browser();

    const alreadyOnDashboard = await AaaCarrier.findDashboardTab(browser);
    if (alreadyOnDashboard) {
      this.policyClubPage = alreadyOnDashboard;
      return;
    }

    let oktaTab =
      this.oktaPage ??
      (await AaaCarrier.findOktaTab(browser)) ??
      this.policyClubPage;

    if (!oktaTab) {
      throw await AaaCarrier.stepError(4, "No Okta tab found", browser);
    }

    this.oktaPage = oktaTab;
    await oktaTab.bringToFront().catch(() => {});
    await this.progress("Step 4/6: Loading Okta verification (JavaScript required)…");
    await AaaCarrier.ensureOktaWidgetReady(oktaTab);

    if (!(await AaaCarrier.hasOktaPasscodeInput(oktaTab))) {
      await this.progress("Step 4/6: Clicking Send me the code…");
      const sent = await AaaCarrier.clickOktaSendCode(oktaTab);
      if (!sent) {
        throw await AaaCarrier.stepError(
          4,
          'Could not find "Send me the code" on Okta',
          browser
        );
      }
      await this.progress("Step 4/6: Code sent — enter it when it arrives");
      await AaaCarrier.waitForOktaCodeInput(oktaTab, 60_000);
    } else {
      await this.progress("Step 4/6: Enter the verification code sent to your email");
    }

    await this.store.transition(sessionId, CarrierState.AWAITING_MFA, {
      statusMessage: this.mfaAwaitingMessage(0),
    });
    const code = await this.awaitMfaCode(sessionId);

    await this.store.transition(sessionId, CarrierState.MFA_SUBMITTED, {
      statusMessage: "Step 4/6: Submitting verification code…",
    });

    const freshOkta =
      (await AaaCarrier.findOktaTab(browser)) ?? this.oktaPage ?? oktaTab;
    await AaaCarrier.submitOktaCode(browser, freshOkta, code);
    this.oktaPage = freshOkta;

    await AaaCarrier.waitForCondition(
      () => AaaCarrier.findDashboardTab(browser),
      NAVIGATION_TIMEOUT,
      "policy dashboard after Okta verify"
    );
  }

  // ─── Step 5: Dashboard ──────────────────────────────────────────────────────

  private async stepWaitPolicyDashboard(page: Page): Promise<void> {
    const browser = (this.mwgPage ?? page).browser();
    const dash = await AaaCarrier.waitForCondition(
      () => AaaCarrier.findDashboardTab(browser),
      NAVIGATION_TIMEOUT,
      "policy dashboard (View policies / View details)"
    );
    this.policyClubPage = dash;
  }

  // ─── Step 6: Documents ──────────────────────────────────────────────────────

  protected async fetchDocuments(page: Page): Promise<DocumentResult["documents"]> {
    const browser = (this.mwgPage ?? page).browser();
    const club =
      this.policyClubPage ??
      (await AaaCarrier.findDashboardTab(browser)) ??
      page;

    await club.bringToFront().catch(() => {});

    const detailsBtn = await club.waitForSelector(SELECTORS.policyDetailsBtn, {
      visible: true,
      timeout: NAVIGATION_TIMEOUT,
    });

    const policyId = await detailsBtn?.evaluate((el) =>
      el.getAttribute("data-testid")?.replace("view-policy-details-button-", "")
    );

    await detailsBtn!.click();

    const pagesBeforePdf = await AaaCarrier.safeBrowserPages(club.browser());
    await club.waitForSelector(SELECTORS.declarationsChip, { visible: true });

    await club.evaluate((sel) => {
      const chips = Array.from(document.querySelectorAll(sel));
      const decl = chips.find((el) =>
        el.textContent?.includes("Policy declarations")
      ) as HTMLElement | undefined;
      decl?.click();
    }, SELECTORS.declarationsChip);

    const pdfPage = await AaaCarrier.waitForNewPage(
      club.browser(),
      pagesBeforePdf,
      NAVIGATION_TIMEOUT
    ).catch(() => club);

    await pdfPage.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {});

    const pdfBytes = await pdfPage.pdf({ format: "A4" });
    const suffix = policyId ?? "unknown";

    return [
      {
        type: "policy",
        filename: `policy-declarations-${suffix}.pdf`,
        mimeType: "application/pdf",
        data: Buffer.from(pdfBytes),
      },
    ];
  }

  // ─── Step runner ──────────────────────────────────────────────────────────────

  private async runStep(
    step: number,
    description: string,
    fn: () => Promise<void>
  ): Promise<void> {
    await this.progress(`Step ${step}/${TOTAL_STEPS}: ${description}`);
    try {
      await fn();
    } catch (err) {
      throw AaaCarrier.wrapStepError(step, err);
    }
  }

  private static async stepError(
    step: number,
    detail: string,
    browser: Browser
  ): Promise<Error> {
    const urls = await AaaCarrier.tabUrls(browser);
    return new Error(
      `AAA step ${step}/${TOTAL_STEPS} failed: ${detail}. Tabs: ${urls.join(", ") || "none"}`
    );
  }

  private static wrapStepError(step: number, err: unknown): Error {
    if (err instanceof Error && err.message.startsWith("AAA step")) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`AAA step ${step}/${TOTAL_STEPS} failed: ${msg}`);
  }

  // ─── Okta helpers ─────────────────────────────────────────────────────────────

  /**
   * Okta serves a noscript fallback when JS is off. Wait for the Sign-In Widget
   * (send-code or passcode step) — not the passcode field alone.
   */
  private static async ensureOktaWidgetReady(tab: Page): Promise<void> {
    await tab.setJavaScriptEnabled(true);

    const cdp = await tab.createCDPSession().catch(() => null);
    await cdp
      ?.send("Emulation.setScriptExecutionDisabled", { value: false })
      .catch(() => {});

    const widgetVisible = async (): Promise<boolean> =>
      tab
        .evaluate(() => {
          const noscript = document.querySelector("#noscript-msg");
          const widget = document.querySelector("#okta-sign-in, #signin-container");
          const send = document.querySelector('input[value="Send me the code"]');
          const answer = document.querySelector('input[name="answer"]');
          if (noscript && !widget && !send && !answer) return false;
          return !!(widget || send || answer);
        })
        .catch(() => false);

    if (!(await widgetVisible())) {
      await tab
        .reload({ waitUntil: "networkidle2", timeout: 60_000 })
        .catch(() => tab.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }));
    }

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await widgetVisible()) return;
      try {
        await tab.waitForSelector(OKTA_WIDGET_SELECTOR, {
          visible: true,
          timeout: 3_000,
        });
        return;
      } catch {
        await sleep(500);
      }
    }

    throw new Error(
      `AAA: Okta sign-in widget did not load (tab: ${AaaCarrier.safeUrl(tab)})`
    );
  }

  private static async findOktaTab(browser: Browser): Promise<Page | null> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      if (OKTA_HOST_URL.test(AaaCarrier.safeUrl(tab))) return tab;
    }
    return null;
  }

  /** Child frames first — Okta often renders the form in an iframe, not the top document. */
  private static liveContexts(tab: Page): OktaDomContext[] {
    const mainFrame = tab.mainFrame();
    const childFrames: Frame[] = [];

    for (const frame of tab.frames()) {
      try {
        void frame.url();
        if (frame !== mainFrame) childFrames.push(frame);
      } catch {
        /* detached */
      }
    }

    childFrames.sort(
      (a, b) =>
        AaaCarrier.framePriority(AaaCarrier.frameUrl(a)) -
        AaaCarrier.framePriority(AaaCarrier.frameUrl(b))
    );

    return [...childFrames, tab];
  }

  private static frameUrl(ctx: OktaDomContext): string {
    try {
      return AaaCarrier.isPage(ctx) ? ctx.url() : ctx.url();
    } catch {
      return "";
    }
  }

  private static framePriority(url: string): number {
    if (/verify\/okta\/email/i.test(url)) return 0;
    if (/\/verify\//i.test(url)) return 1;
    if (/okta\.com/i.test(url)) return 2;
    return 3;
  }

  private static isPage(ctx: OktaDomContext): ctx is Page {
    return typeof (ctx as Page).bringToFront === "function";
  }

  private static pageFromContext(ctx: OktaDomContext, fallback: Page): Page {
    return AaaCarrier.isPage(ctx) ? ctx : (ctx.page() ?? fallback);
  }

  private static async anyContextHasPasscode(tab: Page): Promise<boolean> {
    for (const ctx of AaaCarrier.liveContexts(tab)) {
      const el = await ctx.$(OKTA_PASSCODE_SELECTOR).catch(() => null);
      if (el) return true;
    }
    return false;
  }

  private static async findPasscodeContext(
    tab: Page,
    timeoutMs: number
  ): Promise<OktaDomContext | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const ctx of AaaCarrier.liveContexts(tab)) {
        const el = await ctx.$(OKTA_PASSCODE_SELECTOR).catch(() => null);
        if (el) return ctx;
      }
      await sleep(200);
    }

    return null;
  }

  private static async locateOktaOnTab(
    tab: Page,
    need: OktaNeed
  ): Promise<OktaLoc | null> {
    if (tab.isClosed()) return null;

    for (const ctx of AaaCarrier.liveContexts(tab)) {
      try {
        if (need === "send-code") {
          const send = await AaaCarrier.findFirst(ctx, OKTA_SEND_CODE_SELECTORS);
          if (send) return { page: tab, context: ctx, send };
        }

        const input = await AaaCarrier.findOktaPasscodeInput(ctx);
        const verify = await AaaCarrier.findFirst(ctx, OKTA_VERIFY_SELECTORS);
        if (input) return { page: tab, context: ctx, input, verify };
      } catch {
        /* frame navigated */
      }
    }

    return null;
  }

  private static async hasOktaPasscodeInput(tab: Page): Promise<boolean> {
    for (const ctx of AaaCarrier.liveContexts(tab)) {
      const input = await AaaCarrier.findOktaPasscodeInput(ctx);
      if (input) return true;
    }
    return false;
  }

  private static async findOktaPasscodeInput(
    ctx: OktaDomContext
  ): Promise<ElementHandle<Element> | undefined> {
    for (const sel of OKTA_INPUT_SELECTORS) {
      const el = await ctx.$(sel);
      if (el && (await AaaCarrier.isOktaPasscodeField(el))) return el;
    }

    const handle = await ctx.evaluateHandle(() => {
      for (const el of document.querySelectorAll("input")) {
        const input = el as HTMLInputElement;
        if (input.disabled || input.type === "hidden" || input.type === "submit") {
          continue;
        }
        const hint = `${input.name} ${input.autocomplete} ${input.id}`;
        if (/answer|passcode|one-time-code/i.test(hint)) return input;
        if (input.type === "tel" && input.name === "answer") return input;
      }
      return null;
    });

    const element = handle.asElement() as ElementHandle<Element> | null;
    if (element && (await AaaCarrier.isOktaPasscodeField(element))) {
      return element;
    }

    return undefined;
  }

  private static async isOktaPasscodeField(
    handle: ElementHandle<Element>
  ): Promise<boolean> {
    return handle.evaluate((node) => {
      const input = node as HTMLInputElement;
      if (input.disabled || input.type === "hidden" || input.type === "submit") {
        return false;
      }
      const hint = `${input.name} ${input.autocomplete}`;
      if (/answer|passcode|one-time-code/i.test(hint)) return true;
      return input.type === "tel" && input.name === "answer";
    });
  }

  private static async clickOktaSendCode(tab: Page): Promise<boolean> {
    const loc = await AaaCarrier.locateOktaOnTab(tab, "send-code");
    if (loc?.send) {
      await loc.send.click();
      await sleep(2_000);
      return true;
    }

    const clickScript = () => {
      for (const el of document.querySelectorAll(
        "input[type='submit'], button[type='submit'], button, input.button-primary"
      )) {
        const label =
          (el as HTMLInputElement).value ||
          (el as HTMLButtonElement).textContent ||
          "";
        if (/send me the code/i.test(label.trim())) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    };

    for (const ctx of AaaCarrier.liveContexts(tab)) {
      const clicked = await ctx.evaluate(clickScript).catch(() => false);
      if (clicked) {
        await sleep(2_000);
        return true;
      }
    }

    return false;
  }

  /** After Send code — passcode field appears on same Okta URL. */
  private static async waitForOktaCodeInput(
    tab: Page,
    timeoutMs: number
  ): Promise<ElementHandle<Element>> {
    await tab.bringToFront().catch(() => {});

    try {
      await tab.waitForFunction(
        () => {
          for (const el of document.querySelectorAll("input")) {
            const input = el as HTMLInputElement;
            if (input.disabled || input.type === "hidden" || input.type === "submit") {
              continue;
            }
            const hint = `${input.name} ${input.autocomplete}`;
            if (/answer|passcode|one-time-code/i.test(hint)) return true;
            if (input.type === "tel" && input.name === "answer") return true;
          }
          return false;
        },
        { timeout: Math.min(timeoutMs, 15_000) }
      );
    } catch {
      /* main frame only — fall through to frame scan */
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const ctx of AaaCarrier.liveContexts(tab)) {
        const input = await AaaCarrier.findOktaPasscodeInput(ctx);
        if (input) return input;
      }
      await sleep(300);
    }

    throw new Error(
      `AAA: Timed out waiting for Okta code input (tab: ${AaaCarrier.safeUrl(tab)})`
    );
  }

  /**
   * Fill OTP and click Verify in the live DOM (no ElementHandles held across awaits).
   * Retries because Okta reloads iframes while the user types the code in our UI.
   */
  private static async submitOktaCode(
    browser: Browser,
    tabHint: Page,
    code: string
  ): Promise<void> {
    const safeCode = String(code).replace(/\s/g, "");
    const deadline = Date.now() + OKTA_SUBMIT_TIMEOUT;

    while (Date.now() < deadline) {
      const tab =
        (await AaaCarrier.findOktaTab(browser)) ??
        (tabHint.isClosed() ? null : tabHint);

      if (!tab) {
        await sleep(400);
        continue;
      }

      await tab.bringToFront().catch(() => {});
      await AaaCarrier.ensureOktaWidgetReady(tab);

      if (!(await AaaCarrier.anyContextHasPasscode(tab))) {
        await AaaCarrier.clickOktaSendCode(tab);
        await sleep(2_000);
      }

      try {
        if (await AaaCarrier.fillAndVerifyOktaInTab(tab, safeCode)) {
          await tab
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: NAVIGATION_TIMEOUT,
            })
            .catch(() => {});
          return;
        }
      } catch (err) {
        if (!AaaCarrier.isDetachedError(err)) throw err;
      }

      await sleep(400);
    }

    const hint = await AaaCarrier.oktaPageDebugHint(tabHint);
    throw new Error(
      `AAA: Could not submit Okta code (tab: ${AaaCarrier.safeUrl(tabHint)}). ${hint}`
    );
  }

  private static async fillAndVerifyOktaInTab(
    tab: Page,
    otp: string
  ): Promise<boolean> {
    const ctx = await AaaCarrier.findPasscodeContext(tab, 15_000);

    if (!ctx) {
      for (const fallback of AaaCarrier.liveContexts(tab)) {
        try {
          if (await AaaCarrier.fillOktaViaPuppeteer(fallback, otp, tab)) {
            return true;
          }
          if (await AaaCarrier.fillOktaViaEvaluate(fallback, otp)) return true;
        } catch (err) {
          if (!AaaCarrier.isDetachedError(err)) throw err;
        }
      }
      return false;
    }

    try {
      if (await AaaCarrier.fillOktaViaPuppeteer(ctx, otp, tab)) return true;
      if (await AaaCarrier.fillOktaViaEvaluate(ctx, otp)) return true;
    } catch (err) {
      if (!AaaCarrier.isDetachedError(err)) throw err;
    }

    return false;
  }

  /** Type into the passcode field like a user (works when evaluate cannot see the node). */
  private static async fillOktaViaPuppeteer(
    ctx: OktaDomContext,
    otp: string,
    tab: Page
  ): Promise<boolean> {
    const input =
      (await ctx.$(OKTA_PASSCODE_SELECTOR).catch(() => null)) ??
      (await ctx
        .waitForSelector(OKTA_PASSCODE_SELECTOR, { timeout: 5_000, visible: true })
        .catch(() =>
          ctx.waitForSelector(OKTA_PASSCODE_SELECTOR, {
            timeout: 3_000,
            visible: false,
          })
        )
        .catch(() => null));

    if (!input) return false;

    const page = AaaCarrier.pageFromContext(ctx, tab);
    const keyboard = page.keyboard;

    await input.click();
    await input.click().catch(() => {});
    await input.click().catch(() => {});
    await input.evaluate((el) => {
      (el as HTMLInputElement).value = "";
    });

    try {
      await input.type(otp, { delay: 50 });
    } catch {
      await keyboard.type(otp, { delay: 50 });
    }

    const verify =
      (await ctx.$(OKTA_VERIFY_BUTTON_SELECTOR).catch(() => null)) ??
      (await AaaCarrier.findFirst(ctx, OKTA_VERIFY_SELECTORS).catch(() => null));

    if (verify) {
      await verify.click();
      return true;
    }

    const clicked = await ctx
      .evaluate(() => {
        for (const el of document.querySelectorAll(
          "input[type='submit'], button[type='submit'], button"
        )) {
          const label =
            (el as HTMLInputElement).value ||
            (el as HTMLButtonElement).innerText ||
            "";
          if (/^verify$/i.test(label.trim())) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);

    if (clicked) return true;

    await input.press("Enter");
    return true;
  }

  private static async fillOktaViaEvaluate(
    ctx: OktaDomContext,
    otp: string
  ): Promise<boolean> {
    return ctx.evaluate((code) => {
      const collectInputs = (root: Document | ShadowRoot): HTMLInputElement[] => {
        const list: HTMLInputElement[] = [];
        for (const el of root.querySelectorAll("input")) {
          list.push(el as HTMLInputElement);
        }
        for (const host of root.querySelectorAll("*")) {
          const shadow = (host as HTMLElement).shadowRoot;
          if (shadow) list.push(...collectInputs(shadow));
        }
        return list;
      };

      const pickInput = (): HTMLInputElement | null => {
        for (const input of collectInputs(document)) {
          if (input.disabled || input.type === "hidden" || input.type === "submit") {
            continue;
          }
          const hint = `${input.name} ${input.autocomplete} ${input.id}`;
          if (/answer|passcode|one-time-code/i.test(hint)) return input;
          if (input.type === "tel" && input.name === "answer") return input;
        }
        return null;
      };

      const clickVerify = (): boolean => {
        for (const el of document.querySelectorAll(
          "input[type='submit'], button[type='submit'], button, input.button-primary"
        )) {
          const label =
            (el as HTMLInputElement).value ||
            (el as HTMLButtonElement).innerText ||
            "";
          if (/^verify$/i.test(label.trim())) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      };

      const input = pickInput();
      if (!input) return false;

      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      if (setter) setter.call(input, code);
      else input.value = code;

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      if (clickVerify()) return true;
      input.closest("form")?.requestSubmit();
      return true;
    }, otp);
  }

  private static async oktaPageDebugHint(tab: Page): Promise<string> {
    const parts: string[] = [`pageUrl=${AaaCarrier.safeUrl(tab)}`];

    for (const ctx of AaaCarrier.liveContexts(tab)) {
      const label = AaaCarrier.frameUrl(ctx) || "unknown-frame";
      try {
        const snippet = await ctx.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input"))
            .slice(0, 12)
            .map((el) => {
              const input = el as HTMLInputElement;
              return `${input.type}:${input.name}:${input.id}`;
            });
          const buttons = Array.from(
            document.querySelectorAll("input[type='submit'], button")
          )
            .slice(0, 8)
            .map((el) => {
              return (
                (el as HTMLInputElement).value ||
                (el as HTMLButtonElement).innerText ||
                ""
              ).trim();
            });
          return `inputs=[${inputs.join("; ")}] buttons=[${buttons.join("; ")}]`;
        });
        parts.push(`{${label}: ${snippet}}`);
      } catch {
        parts.push(`{${label}: no-access}`);
      }
    }

    return parts.join(" | ");
  }

  private static isDetachedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /detached Frame|Execution context was destroyed|Cannot find context/i.test(
      msg
    );
  }

  // ─── Dashboard / tabs ─────────────────────────────────────────────────────────

  private static async findDashboardTab(browser: Browser): Promise<Page | null> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      if (await AaaCarrier.hasPolicyDashboard(tab)) return tab;
    }
    return null;
  }

  private static async hasPolicyDashboard(tab: Page): Promise<boolean> {
    if (tab.isClosed()) return false;
    try {
      return await tab.evaluate(
        (dashSel, detailsSel) => {
          if (document.querySelector(detailsSel)) return true;
          const dash = document.querySelector(dashSel);
          if (dash?.textContent?.includes("View policies")) return true;
          const text = document.body?.innerText ?? "";
          return /view details|view policies|your policies/i.test(text);
        },
        SELECTORS.dashboardText,
        SELECTORS.policyDetailsBtn
      );
    } catch {
      return false;
    }
  }

  /** Popup tab opened by Manage Policy (target=_blank). */
  private static async waitForNewPolicyClubTab(
    browser: Browser,
    pagesBefore: Page[],
    timeoutMs: number
  ): Promise<Page | null> {
    const known = new Set(pagesBefore);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        if (known.has(tab)) continue;
        if (await AaaCarrier.tabReachedAuthDestination(tab)) return tab;
      }
      await sleep(250);
    }

    return null;
  }

  /** Tab finished SSO handoff — Okta, Policy Club host, or dashboard. */
  private static async tabReachedAuthDestination(tab: Page): Promise<boolean> {
    if (tab.isClosed()) return false;
    const url = AaaCarrier.safeUrl(tab);
    if (!url || url === "about:blank") return false;
    if (OKTA_HOST_URL.test(url)) return true;
    if (POLICY_CLUB_URL.test(url)) return true;
    if (await AaaCarrier.hasPolicyDashboard(tab)) return true;
    return false;
  }

  private static async waitForTabReachAuth(
    tab: Page,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastUrl = "";

    while (Date.now() < deadline) {
      if (await AaaCarrier.tabReachedAuthDestination(tab)) return;
      const url = AaaCarrier.safeUrl(tab);
      if (url && url !== lastUrl) lastUrl = url;
      await sleep(300);
    }

    throw new Error(
      `AAA step 3/6: Policy Club tab did not load (last URL: ${lastUrl || "unknown"})`
    );
  }

  private static async navigatePolicyClubTab(
    tab: Page,
    href: string
  ): Promise<void> {
    try {
      await tab.goto(href, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT,
      });
    } catch (err) {
      if (await AaaCarrier.tabReachedAuthDestination(tab)) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/LifecycleWatcher disposed|net::ERR_ABORTED|Navigating frame was detached/i.test(msg)) {
        throw err;
      }
    }

    await AaaCarrier.waitForTabReachAuth(tab, NAVIGATION_TIMEOUT);
  }

  /** On insurance page or Manage Policy is visible (ready for step 3). */
  private static async isMwgInsuranceReady(mwg: Page): Promise<boolean> {
    if (/\/my-account\/insurance/i.test(AaaCarrier.safeUrl(mwg))) return true;

    const manage = await mwg.$(SELECTORS.managePolicyLink);
    if (!manage) return false;

    return manage
      .evaluate((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .catch(() => false);
  }

  private static async waitForMwgInsuranceReady(
    mwg: Page,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await AaaCarrier.isMwgInsuranceReady(mwg)) return;
      await sleep(300);
    }

    throw new Error(
      `AAA step 2/6: Insurance page not ready (url: ${AaaCarrier.safeUrl(mwg)})`
    );
  }

  private static async resolveManagePolicyHref(mwg: Page): Promise<string> {
    for (const sel of [
      SELECTORS.managePolicyLink,
      'a[href*="mypolicyclub.digital.csaa-insurance.aaa.com/policies"]',
    ]) {
      const handle = await mwg.$(sel);
      if (!handle) continue;
      const href = await handle.evaluate((el) => (el as HTMLAnchorElement).href?.trim());
      if (href && /\/policies/i.test(href)) return href;
    }
    return POLICY_CLUB_POLICIES_URL;
  }

  private static async waitForCondition<T>(
    fn: () => Promise<T | null>,
    timeoutMs: number,
    label: string
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await sleep(300);
    }

    throw new Error(`AAA: Timed out waiting for ${label}`);
  }

  // ─── Browser utilities ────────────────────────────────────────────────────────

  private static async safeBrowserPages(browser: Browser): Promise<Page[]> {
    try {
      const pages = await browser.pages();
      return pages.filter((tab) => {
        try {
          return !tab.isClosed();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private static safeUrl(tab: Page): string {
    try {
      return tab.url();
    } catch {
      return "";
    }
  }

  private static async tabUrls(browser: Browser): Promise<string[]> {
    const seen = new Set<string>();
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      const url = AaaCarrier.safeUrl(tab);
      if (url) seen.add(url);
    }
    return [...seen];
  }

  private static async findFirst(
    ctx: OktaDomContext,
    selectors: readonly string[]
  ): Promise<ElementHandle<Element> | undefined> {
    for (const sel of selectors) {
      const el = await ctx.$(sel);
      if (el) return el;
    }
    return undefined;
  }

  private static async waitForNewPage(
    browser: Browser,
    pagesBefore: Page[],
    timeoutMs: number
  ): Promise<Page> {
    const known = new Set(pagesBefore);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        if (!known.has(tab)) return tab;
      }
      await sleep(250);
    }

    throw new Error("AAA: Timed out waiting for a new browser tab");
  }

  private static extractCredentials(
    credentials: Record<string, string>
  ): { email: string; password: string } {
    const { email, password } = credentials;
    if (!email) throw new Error("AaaCarrier: missing credential 'email'");
    if (!password) throw new Error("AaaCarrier: missing credential 'password'");
    return { email, password };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
