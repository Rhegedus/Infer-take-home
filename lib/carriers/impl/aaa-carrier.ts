import { Browser, ElementHandle, Frame, Page } from "puppeteer-core";
import { BaseCarrier } from "../base-carrier";
import { CarrierState, DocumentResult } from "../types";

// ─── Exact URLs from manual flow ──────────────────────────────────────────────
const MWG_SIGN_IN_URL = "https://mwg.aaa.com/my-account/insurance";
const POLICY_CLUB_POLICIES_URL =
  "https://www.mypolicy.csaa-insurance.aaa.com/policies";

// ─── MWG sign-in selectors ────────────────────────────────────────────────────
const SEL_EMAIL = 'input[name="username"]';
const SEL_CONTINUE = 'button[data-action-button-primary="true"]';
const SEL_PASSWORD = 'input[name="password"]';
const SEL_SIGN_IN = "button._button-login-password";

// ─── Okta selectors ───────────────────────────────────────────────────────────
const SEL_OKTA_SEND_CODE = 'input[value="Send me the code"]';
const SEL_OKTA_CODE_INPUT =
  'input[name="answer"], input[name="credentials.passcode"], input[autocomplete="one-time-code"], input[type="tel"][name="answer"]';
const SEL_OKTA_VERIFY = 'input[value="Verify"], input[data-type="save"][value="Verify"]';
/** AAA email-verify form uses input[name="answer"] */
const SEL_OKTA_ANSWER = 'input[name="answer"]';

// ─── Policy club selectors (exact from manual flow) ───────────────────────────
// data-testid="view-policy-details-button-CAAS202509246" href="/policy/CAAS202509246"
const SEL_VIEW_DETAILS = 'a[data-testid^="view-policy-details-button-"]';

// data-testid="viewDocumentsButton" href="/documents/CAAS202509246"
const SEL_VIEW_DOCUMENTS = 'a[data-testid="viewDocumentsButton"]';

// data-testid="Auto-Declaration-Page-link" href="blob:..." target="_blank"
const SEL_AUTO_DECLARATION = 'a[data-testid="Auto-Declaration-Page-link"]';

// Interstitial that appears after zip gate: "Continue to my AAA club"
const SEL_CLUB_INTERSTITIAL = '[data-testid="continue-to-club-button"]';

const NAV_TIMEOUT = 30_000;
const DOM_TIMEOUT = 15_000;
const OKTA_SUBMIT_TIMEOUT = 45_000;

type OktaCtx = Page | Frame;

/**
 * AAA carrier — manual flow:
 *
 * 1. MWG sign-in
 * 2. Okta MFA (if presented after login)
 * 3. Go to https://www.mypolicy.csaa-insurance.aaa.com/policies
 * 4. Okta MFA (if presented for Policy Club)
 * 5. Policies dashboard — first "View details"
 * 6. "View documents"
 * 7. "Auto Declaration Page" (blob PDF, target="_blank")
 */
const TOTAL_STEPS = 7;

export class AaaCarrier extends BaseCarrier {
  readonly carrierId = "aaa";
  private _credentials: Record<string, string> = {};
  /** Active mypolicy tab — set once we reach the policies dashboard */
  private policyClubTab: Page | null = null;
  private mfaRound = 0;
  /** Avoid re-filling zip while waiting for post-submit redirect */
  private zipGateSubmitted = false;

  protected override mfaAwaitingMessage(round: number): string {
    return round > 1
      ? "Enter the Okta verification code (required again for Policy Club)"
      : "Enter the Okta verification code sent to your email";
  }

  // ─── Stubs required by BaseCarrier ───────────────────────────────────────────
  protected async login(): Promise<void> {}
  protected async detectMfa(): Promise<boolean> { return false; }
  protected async navigateToDocumentsArea(): Promise<void> {}
  protected async submitMfaInBrowser(): Promise<void> {}

  // ─── Main pipeline ─────────────────────────────────────────────────────────
  protected override async runPipeline(
    sessionId: string,
    credentials: Record<string, string>
  ): Promise<DocumentResult> {
    const { email, password } = AaaCarrier.creds(credentials);
    this._credentials = credentials;
    this.mfaRound = 0;
    this.policyClubTab = null;
    this.zipGateSubmitted = false;

    await this.progress("Launching secure browser…");
    const page = await this.openBrowser();

    // ── Step 1: MWG sign-in ─────────────────────────────────────────────────
    await this.progress(`Step 1/${TOTAL_STEPS}: MWG sign-in…`);
    await this.stepMwgSignIn(page, email, password);
    await sleep(2_000);

    // ── Step 2: Okta MFA after login (if presented) ─────────────────────────
    await this.progress(`Step 2/${TOTAL_STEPS}: Okta MFA (after login)…`);
    await this.stepOktaMfaIfNeeded(sessionId, page);

    // ── Step 3: Go to Policy Club /policies ─────────────────────────────────
    await this.progress(`Step 3/${TOTAL_STEPS}: Opening policies…`);
    const browser = page.browser();
    const liveTab = await AaaCarrier.resolveLivePolicyTab(browser, page);
    let policiesPage = await AaaCarrier.safeGoto(liveTab, POLICY_CLUB_POLICIES_URL);
    console.log(`[aaa] After policies goto, URL: ${AaaCarrier.safeUrl(policiesPage)}`);

    // Redirect to Okta or zip gate can lag behind domcontentloaded
    await AaaCarrier.waitForOktaOrPolicyClub(browser, NAV_TIMEOUT);
    policiesPage = await AaaCarrier.resolveActiveMypolicyTab(browser, policiesPage);

    // Zip gate — poll until the React form is actually rendered (short wait; may appear later)
    policiesPage = await this.stepWaitAndHandleZipGate(browser, policiesPage, 15_000);

    // ── Step 4: Okta MFA for Policy Club (if presented) ─────────────────────
    await this.progress(`Step 4/${TOTAL_STEPS}: Okta MFA (Policy Club)…`);
    await this.stepOktaMfaIfNeeded(sessionId, policiesPage);

    // Zip may only appear after Okta — wait longer here
    policiesPage = await this.stepWaitAndHandleZipGate(browser, policiesPage, 60_000);

    // ── Step 5: Policies dashboard (handles late Okta / zip) ─────────────────
    await this.progress(`Step 5/${TOTAL_STEPS}: Policies dashboard…`);
    const policiesTab = await this.stepEnsureOnPolicies(sessionId, policiesPage);

    let documentsTab = policiesTab;
    let policyId: string | null = null;

    // ── Step 6: View details → View documents (skip if already on documents) ─
    if (await AaaCarrier.isDocumentsReady(policiesTab)) {
      console.log("[aaa] Already on documents page — skipping View details / View documents");
    } else {
      await this.progress(`Step 6/${TOTAL_STEPS}: Opening policy documents…`);
      const details = await this.stepClickViewDetails(policiesTab);
      policyId = details.policyId;
      documentsTab = await this.stepClickViewDocuments(details.tab);
    }

    // ── Step 7: Auto Declaration PDF ─────────────────────────────────────────
    await this.progress(`Step 7/${TOTAL_STEPS}: Downloading Auto Declaration PDF…`);
    await this.store.transition(sessionId, CarrierState.FETCHING_DOCS, {
      statusMessage: "Downloading Auto Declaration PDF…",
    });
    const documents = await this.stepDownloadDeclaration(documentsTab, policyId, sessionId);

    return this.finalizeDocuments(sessionId, documents);
  }

  // ─── Step 1: MWG sign-in ───────────────────────────────────────────────────
  private async stepMwgSignIn(
    page: Page,
    email: string,
    password: string
  ): Promise<void> {
    await page.goto(MWG_SIGN_IN_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });

    // Check if login form is present
    const needsLogin = await page
      .waitForSelector(SEL_EMAIL, { visible: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!needsLogin) {
      console.log("[aaa] Already signed in to MWG — skipping sign-in");
      return;
    }

    console.log("[aaa] Typing email…");
    await page.type(SEL_EMAIL, email, { delay: 40 });
    await page.click(SEL_CONTINUE);

    console.log("[aaa] Typing password…");
    await page.waitForSelector(SEL_PASSWORD, { visible: true, timeout: DOM_TIMEOUT });
    await page.type(SEL_PASSWORD, password, { delay: 40 });

    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
        .catch(() => {}),
      page.click(SEL_SIGN_IN),
    ]);

    console.log(`[aaa] After sign-in, URL: ${page.url()}`);
  }

  // ─── Step 2b: Zip code gate ─────────────────────────────────────────────────
  /**
   * Handles two zip code gate variants:
   *  1. https://www.mypolicy.csaa-insurance.aaa.com/policy-zip?redirectTo=...
   *     input: name="zipCode", data-testid="zip-code-continue-button"
   *  2. https://csaa-insurance.aaa.com/.../manage-mypolicy.html
   *     input: name="zipcode" id="zipcode", button id="zipSubmitButton"
   */
  /**
   * Poll for policy-zip tab, wait for React form to render, then submit zip once.
   * Returns the active mypolicy tab (may still be on zip while redirect pending).
   */
  private async stepWaitAndHandleZipGate(
    browser: Browser,
    page: Page,
    maxWaitMs = 60_000
  ): Promise<Page> {
    // Already past zip gate
    if (await AaaCarrier.hasPoliciesDashboard(browser)) {
      return await AaaCarrier.resolveActiveMypolicyTab(browser, page);
    }

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        const url = AaaCarrier.safeUrl(tab);
        if (!url.includes("policy-zip") && !url.includes("manage-mypolicy")) {
          continue;
        }

        await tab.bringToFront().catch(() => {});
        await tab.setJavaScriptEnabled(true).catch(() => {});

        if (this.zipGateSubmitted) {
          console.log("[aaa] Zip already submitted — waiting for redirect…");
          const left = await this.waitForLeaveZipGate(tab, 5_000).then(() => true).catch(() => false);
          if (left) {
            return await AaaCarrier.resolveActiveMypolicyTab(browser, tab);
          }
          console.log("[aaa] Still on zip gate after waiting — resetting submitted flag to retry");
          this.zipGateSubmitted = false;
        }

        await this.waitForZipPageReady(tab);
        await this.progress("Entering policy zip code…");
        await this.stepHandleZipGate(tab, this._credentials);
        return await AaaCarrier.resolveActiveMypolicyTab(browser, tab);
      }

      // Not on zip yet — keep polling (redirect can lag 30s+ behind domcontentloaded)
      await sleep(500);
    }

    return page;
  }

  /** Wait for the policy-zip SPA to render the form (blank body = not ready) */
  private async waitForZipPageReady(tab: Page): Promise<void> {
    const ZIP_READY_SEL =
      'input[name="zipCode"], input[name="zipcode"], input[id="zipcode"], [data-testid="zip-code-continue-button"]';

    console.log("[aaa] Waiting for zip gate page to render…");
    await sleep(2_000);

    const ready = await tab
      .waitForSelector(ZIP_READY_SEL, { visible: true, timeout: 45_000 })
      .then(() => true)
      .catch(() => false);

    if (ready) return;

    // Blank SPA shell — reload once and wait again
    console.log("[aaa] Zip page still blank — reloading…");
    await tab.reload({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});
    await tab.waitForSelector(ZIP_READY_SEL, { visible: true, timeout: 45_000 });
  }

  private async stepHandleZipGateIfPresent(page: Page): Promise<void> {
    const url = AaaCarrier.safeUrl(page);
    if (!url.includes("policy-zip") && !url.includes("manage-mypolicy")) return;
    await this.waitForZipPageReady(page);
    await this.progress("Entering policy zip code…");
    await this.stepHandleZipGate(page, this._credentials);
  }

  private async stepHandleZipGate(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void> {
    const url = AaaCarrier.safeUrl(page);
    const isZipPage = url.includes("policy-zip") || url.includes("manage-mypolicy");
    if (!isZipPage) return;

    // Already submitted — just wait for redirect, do not re-fill
    if (this.zipGateSubmitted) {
      console.log("[aaa] Zip already submitted — waiting for redirect…");
      await this.waitForLeaveZipGate(page, NAV_TIMEOUT);
      return;
    }

    const zipCode = credentials.zipCode;
    if (!zipCode) {
      throw new Error(
        `AAA: Hit zip code gate (${url}) but no zipCode credential was provided`
      );
    }

    console.log(`[aaa] Zip gate: ${url} — entering zip: ${zipCode}`);

    const ZIP_INPUT_SEL =
      'input[name="zipCode"], input[name="zipcode"], input[id="zipcode"]';
    const ZIP_SUBMIT_SEL =
      '[data-testid="zip-code-continue-button"], #zipSubmitButton';

    // waitForZipPageReady already ran — grab input immediately
    const zipInput = await page.$(ZIP_INPUT_SEL).catch(() => null);
    if (!zipInput) {
      await this.waitForZipPageReady(page);
    }

    console.log("[aaa] Waiting for zip input…");
    const input = await page
      .waitForSelector(ZIP_INPUT_SEL, { visible: true, timeout: 15_000 })
      .catch(() => null);

    if (!input) {
      const html = await page
        .evaluate(() => document.body?.innerText?.substring(0, 300) ?? "")
        .catch(() => "");
      throw new Error(`AAA: Could not find zip code input on ${url}. Page: ${html}`);
    }

    console.log("[aaa] Zip input found — typing zip code…");
    await this.fillZipInput(page, zipCode);

    console.log("[aaa] Waiting for submit button to enable…");
    await page
      .waitForSelector(`${ZIP_SUBMIT_SEL}:not([disabled])`, {
        visible: true,
        timeout: 15_000,
      })
      .catch(() => {});

    this.zipGateSubmitted = true;
    await this.submitZipAndProceed(page, url);

    console.log(`[aaa] After zip submission, URL: ${AaaCarrier.safeUrl(page)}`);
  }

  /** Human-like zip entry — works with React/MUI controlled inputs */
  private async fillZipInput(page: Page, zipCode: string): Promise<void> {
    const ZIP_INPUT_SEL =
      'input[name="zipCode"], input[name="zipcode"], input[id="zipcode"]';

    await page.click(ZIP_INPUT_SEL, { count: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type(zipCode, { delay: 100 });
    await sleep(500);

    const val = await page
      .$eval(ZIP_INPUT_SEL, (el) => (el as HTMLInputElement).value)
      .catch(() => "");

    console.log(`[aaa] Zip field value after type: "${val}"`);

    if (val !== zipCode) {
      await page.evaluate((zip) => {
        const input = document.querySelector(
          'input[name="zipCode"], input[name="zipcode"], input[id="zipcode"]'
        ) as HTMLInputElement | null;
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) setter.call(input, zip);
        else input.value = zip;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, zipCode);
    }
  }

  /** Click Continue and wait for redirect; retry + fallback goto if needed */
  private async submitZipAndProceed(page: Page, zipPageUrl: string): Promise<void> {
    const browser = page.browser();

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[aaa] Zip submit attempt ${attempt}/3…`);

      const tab =
        (await AaaCarrier.findPolicyZipTab(browser)) ??
        (page.isClosed() ? null : page);

      if (!tab) {
        if (await AaaCarrier.hasLeftZipGate(browser)) {
          console.log("[aaa] Zip gate passed (tab navigated away)");
          return;
        }
        await sleep(1_000);
        continue;
      }

      let frameDetached = false;
      try {
        await tab.bringToFront().catch(() => {});

        const ZIP_INPUT_SEL = 'input[name="zipCode"], input[name="zipcode"], input[id="zipcode"]';

        // Primary method: focus the zip input and press Enter.
        // This fires real keyboard events that React definitely listens to,
        // and submits the form regardless of whether the button is enabled.
        const inputHandle = await tab.$(ZIP_INPUT_SEL).catch(() => null);
        if (inputHandle) {
          await inputHandle.focus().catch(() => {});
          console.log(`[aaa] Zip submit attempt ${attempt}: pressing Enter on input…`);
          await tab.keyboard.press("Enter");
        } else {
          // Fallback: click the submit button
          const BTN_SEL = '[data-testid="zip-code-continue-button"], #zipSubmitButton';
          const clicked = await tab.click(BTN_SEL).then(() => true).catch(() => false);
          if (!clicked) {
            // Last resort: evaluate-based submit
            await tab.evaluate(() => {
              const btn = document.querySelector(
                '[data-testid="zip-code-continue-button"], #zipSubmitButton'
              ) as HTMLElement | null;
              if (btn) { btn.click(); return; }
              const input = document.querySelector(
                'input[name="zipCode"], input[name="zipcode"]'
              ) as HTMLInputElement | null;
              input?.closest("form")?.requestSubmit();
            });
          }
        }
      } catch (err) {
        if (!AaaCarrier.isDetachedError(err)) throw err;
        // A detached-frame error means the submit caused a navigation —
        // the redirect is already in progress. Give it time to settle.
        frameDetached = true;
        console.log("[aaa] Zip submit: frame detached — navigation in progress, waiting…");
      }


      // When the frame detaches the redirect is actively happening.
      // Wait long enough for the React SPA to finish loading.
      const waitMs = frameDetached ? 5_000 : 2_000;
      await sleep(waitMs);

      // The "Continue to my AAA club" interstitial can appear right after
      // zip submission — click it before checking hasLeftZipGate.
      await AaaCarrier.dismissClubInterstitial(browser);

      if (await AaaCarrier.hasLeftZipGate(browser)) {
        console.log("[aaa] Zip gate passed after submit");
        return;
      }
    }

    // All 3 attempts done. The redirect may still be in-flight (slow network).
    // Wait one extra cycle before resorting to a direct goto.
    console.log("[aaa] Zip submit: waiting 5s for any in-flight redirect to settle…");
    await sleep(5_000);

    if (await AaaCarrier.hasLeftZipGate(browser)) {
      console.log("[aaa] Zip gate passed (delayed redirect)");
      return;
    }

    console.log("[aaa] Zip submit did not redirect — trying direct navigation…");
    await this.navigatePastZipGate(browser, zipPageUrl);
    await AaaCarrier.waitForPoliciesDashboard(browser, NAV_TIMEOUT);
  }

  /** Navigate to redirectTo target after zip submit (session cookie may be set) */
  private async navigatePastZipGate(browser: Browser, zipPageUrl: string): Promise<void> {
    let target = POLICY_CLUB_POLICIES_URL;
    try {
      const parsed = new URL(zipPageUrl);
      const redirectTo = parsed.searchParams.get("redirectTo");
      if (redirectTo) target = `${parsed.origin}${redirectTo}`;
    } catch {
      /* use default */
    }

    // Before navigating, check if the redirect already completed on its own.
    if (await AaaCarrier.hasLeftZipGate(browser)) {
      console.log("[aaa] Zip gate already passed — skipping goto");
      return;
    }

    console.log(`[aaa] Zip gate fallback goto: ${target}`);

    // Find the best live tab to drive. Prefer the one that's currently transitioning
    // (i.e. was on policy-zip and is now mid-redirect to /policies).
    const pages = await AaaCarrier.safeBrowserPages(browser);
    const candidate =
      pages.find(p => {
        const u = AaaCarrier.safeUrl(p);
        return u.includes("mypolicy.csaa-insurance.aaa.com");
      }) ?? pages.find(p => !p.isClosed());

    if (!candidate) {
      throw new Error("AAA: No live browser tab found for zip gate fallback navigation");
    }

    try {
      await candidate.goto(target, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
    } catch (err) {
      if (!AaaCarrier.isDetachedError(err)) throw err;
      // Tab is still mid-redirect — wait for it to settle naturally.
      console.log("[aaa] Zip gate fallback goto: frame detached — waiting for redirect to settle…");
      await sleep(5_000);
      if (!await AaaCarrier.hasLeftZipGate(browser)) {
        // Last resort: find the freshest tab and navigate.
        const fresh = await AaaCarrier.resolveActiveMypolicyTab(browser, candidate);
        await fresh.goto(target, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});
      }
    }
  }

  /** Wait until policy-zip redirects to /policies or View details appears */
  private async waitForLeaveZipGate(page: Page, timeoutMs: number): Promise<void> {
    if (await AaaCarrier.hasLeftZipGate(page.browser())) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await AaaCarrier.hasLeftZipGate(page.browser())) return;
      await sleep(500);
    }

    throw new Error(`still-on-zip:${AaaCarrier.safeUrl(page)}`);
  }

  // ─── Step 3: Okta MFA if presented ────────────────────────────────────────
  private async stepOktaMfaIfNeeded(
    sessionId: string,
    page: Page
  ): Promise<void> {
    const browser = page.browser();

    // Poll — Okta redirect after /policies can take several seconds
    const oktaTab = await AaaCarrier.waitForOktaTab(browser, 20_000);
    if (!oktaTab) {
      console.log("[aaa] No Okta detected — skipping MFA");
      return;
    }

    this.mfaRound += 1;
    console.log(
      `[aaa] Okta MFA detected (round ${this.mfaRound}) — tab: ${AaaCarrier.safeUrl(oktaTab)}`
    );
    await oktaTab.bringToFront().catch(() => {});

    // Ensure JS is enabled for Okta
    await oktaTab.setJavaScriptEnabled(true);

    // Wait for the Okta widget
    await this.waitForOktaWidget(oktaTab);

    // Click "Send me the code" if not already on code entry screen
    const hasCodeInput = await this.hasCodeInput(oktaTab);
    if (!hasCodeInput) {
      console.log("[aaa] Clicking 'Send me the code'…");
      await this.clickSendCode(oktaTab);
      console.log("[aaa] Code sent — waiting for input field…");
      await this.waitForCodeInput(oktaTab, 30_000);
    } else {
      console.log("[aaa] Code input already present");
    }

    // ── PAUSE: ask user for code ────────────────────────────────────────────
    await this.store.transition(sessionId, CarrierState.AWAITING_MFA, {
      statusMessage: this.mfaAwaitingMessage(this.mfaRound),
    });
    console.log(`[aaa][${sessionId}] Waiting for you to enter your verification code…`);
    const code = await this.awaitMfaCode(sessionId);
    console.log(`[aaa][${sessionId}] Code received — entering it now…`);

    await this.store.transition(sessionId, CarrierState.MFA_SUBMITTED, {
      statusMessage: "Submitting verification code…",
    });

    // Re-find Okta tab after user wait (iframe may have reloaded) and submit in live DOM
    const freshOkta =
      (await AaaCarrier.findOktaTab(browser)) ?? oktaTab;
    await AaaCarrier.submitOktaCode(browser, freshOkta, String(code).trim());

    // Wait for redirect onto policy club after verify
    await AaaCarrier.waitForPostOktaRedirect(browser, NAV_TIMEOUT);
  }

  /** True when tab is on the documents page with the declaration link ready */
  private static async isDocumentsReady(tab: Page): Promise<boolean> {
    try {
      if (!AaaCarrier.safeUrl(tab).includes("/documents")) return false;
      return !!(await tab.$(SEL_AUTO_DECLARATION).catch(() => null));
    } catch {
      return false;
    }
  }

  // ─── Step 5: Ensure we're on /policies (or documents) ──────────────────────
  private async stepEnsureOnPolicies(sessionId: string, page: Page): Promise<Page> {
    const browser = page.browser();
    const deadline = Date.now() + 90_000;
    let lastLogAt = 0;

    while (Date.now() < deadline) {
      const oktaTab = await AaaCarrier.findOktaTab(browser);
      if (oktaTab) {
        console.log("[aaa] Okta present — running MFA before policies dashboard…");
        await this.stepOktaMfaIfNeeded(sessionId, oktaTab);
        continue;
      }

      const zipTab = await AaaCarrier.findPolicyZipTab(browser);
      if (zipTab) {
        await this.stepWaitAndHandleZipGate(browser, zipTab, 30_000);
        continue;
      }

      // Dismiss the "Continue to my AAA club" interstitial on any tab
      await AaaCarrier.dismissClubInterstitial(browser);

      if (Date.now() - lastLogAt > 5_000) {
        const tabs = await AaaCarrier.safeBrowserPages(browser);
        console.log(
          `[aaa] Waiting for View details… tabs: ${tabs.map((t) => AaaCarrier.safeUrl(t)).join(" | ")}`
        );
        lastLogAt = Date.now();
      }

      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        try {
          const url = AaaCarrier.safeUrl(tab);
          if (!url.includes("mypolicy.csaa-insurance.aaa.com")) continue;
          if (url.includes("policy-zip")) continue;

          await tab.bringToFront().catch(() => {});

          if (await AaaCarrier.isDocumentsReady(tab)) {
            console.log(`[aaa] On documents page: ${url}`);
            this.policyClubTab = tab;
            return tab;
          }

          if (url.includes("/policies")) {
            const remaining = deadline - Date.now();
            if (await this.waitForViewDetailsOnTab(tab, remaining)) {
              console.log(`[aaa] Policies dashboard ready: ${url}`);
              this.policyClubTab = tab;
              return tab;
            }
          }
        } catch (err) {
          if (AaaCarrier.isDetachedError(err)) continue;
          throw err;
        }
      }

      await sleep(1_000);
    }

    const target = await AaaCarrier.resolveLivePolicyTab(browser, page);
    const snippet = await target
      .evaluate(() => document.body?.innerText?.substring(0, 300) ?? "")
      .catch(() => "(closed)");
    throw new Error(
      `AAA: Timed out waiting for View details on policies dashboard. Last page: ${snippet}`
    );
  }

  /** Wait for the /policies React app to render View details links */
  private async waitForViewDetailsOnTab(tab: Page, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false;

    await tab.setJavaScriptEnabled(true).catch(() => {});

    // Dismiss the "Continue to my AAA club" interstitial if it appears
    // before the policies list renders.
    await AaaCarrier.dismissClubInterstitial(tab.browser()).catch(() => {});

    const tryWait = async (ms: number): Promise<boolean> =>
      tab
        .waitForSelector(SEL_VIEW_DETAILS, { visible: true, timeout: ms })
        .then(() => true)
        .catch(() => false);

    if (await tryWait(Math.min(20_000, timeoutMs))) return true;

    const bodyLen = await tab
      .evaluate(() => document.body?.innerText?.trim().length ?? 0)
      .catch(() => 0);

    if (bodyLen < 30) {
      console.log("[aaa] Policies page empty — waiting for network, then reload…");
      await tab
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 })
        .catch(() => {});
      await sleep(2_000);
      await tab.reload({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT }).catch(() => {});
      await sleep(2_000);
    }

    const remaining = Math.max(5_000, timeoutMs - 5_000);
    if (await tryWait(Math.min(30_000, remaining))) return true;

    const snippet = await tab
      .evaluate(() => document.body?.innerText?.substring(0, 150) ?? "")
      .catch(() => "");
    if (snippet) {
      console.log(`[aaa] View details not found yet. Page: ${snippet.slice(0, 80)}…`);
    }
    return false;
  }

  // ─── Step 6a: Click "View details" ─────────────────────────────────────────
  private async stepClickViewDetails(
    tab: Page
  ): Promise<{ policyId: string | null; tab: Page }> {
    console.log(`[aaa] On page: ${tab.url()}`);

    // Wait for and click the FIRST "View details" link
    const detailsLink = await tab.waitForSelector(SEL_VIEW_DETAILS, {
      visible: true,
      timeout: NAV_TIMEOUT,
    });

    if (!detailsLink) throw new Error("AAA: Could not find 'View details' link");

    const policyId = await detailsLink.evaluate((el) =>
      (el as HTMLAnchorElement)
        .getAttribute("data-testid")
        ?.replace("view-policy-details-button-", "") ?? null
    );

    console.log(`[aaa] Clicking 'View details' for policy: ${policyId}`);
    await detailsLink.click();

    // Wait for the policy detail page to load
    await tab
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
      .catch(() => {});

    console.log(`[aaa] After 'View details' click, URL: ${tab.url()}`);
    this.policyClubTab = tab;
    return { policyId, tab };
  }

  // ─── Step 6b: Click "View documents" ───────────────────────────────────────
  private async stepClickViewDocuments(tab: Page): Promise<Page> {
    await tab.bringToFront().catch(() => {});

    const viewDocs = await tab.waitForSelector(SEL_VIEW_DOCUMENTS, {
      visible: true,
      timeout: NAV_TIMEOUT,
    });

    if (!viewDocs) {
      throw new Error("AAA: Could not find 'View documents' link");
    }

    console.log("[aaa] Clicking 'View documents'…");
    await Promise.all([
      tab
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
        .catch(() => {}),
      viewDocs.click(),
    ]);

    await sleep(2_000);
    console.log(`[aaa] After 'View documents', URL: ${tab.url()}`);

    await tab.waitForSelector(SEL_AUTO_DECLARATION, {
      visible: true,
      timeout: NAV_TIMEOUT,
    });

    this.policyClubTab = tab;
    return tab;
  }

  // ─── Step 7: Click "Auto Declaration Page" and download PDF ──────────────
  private async stepDownloadDeclaration(
    workingPage: Page,
    policyId: string | null,
    _sessionId: string
  ): Promise<DocumentResult["documents"]> {
    const browser = workingPage.browser();

    await workingPage.bringToFront().catch(() => {});
    console.log(`[aaa] On documents page: ${workingPage.url()}`);

    // Wait for the documents page to settle
    console.log("[aaa] Waiting for documents page to settle…");
    await workingPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 8_000 }).catch(() => {});
    await sleep(3_000);

    // Wait for "Auto Declaration Page" link with robust retries
    console.log("[aaa] Waiting for 'Auto Declaration Page' link with retries…");
    let declLink: ElementHandle<Element> | null = null;
    const deadline = Date.now() + NAV_TIMEOUT;
    while (Date.now() < deadline) {
      try {
        declLink = await workingPage.waitForSelector(SEL_AUTO_DECLARATION, {
          visible: true,
          timeout: 3_000,
        });
        if (declLink) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("detached") || msg.includes("Session closed") || msg.includes("Target closed")) {
          console.log("[aaa] Frame detached or page navigated while waiting. Retrying in 1s...");
          await sleep(1_000);
          try {
            const pages = await AaaCarrier.safeBrowserPages(browser);
            const docPage = pages.find((tab) => tab.url().includes("/documents"));
            if (docPage) {
              workingPage = docPage;
              await workingPage.bringToFront().catch(() => {});
            }
          } catch { /* ignore */ }
          continue;
        }
      }
      await sleep(500);
    }

    if (!declLink) {
      throw new Error(
        `AAA: Could not find 'Auto Declaration Page' link (page: ${workingPage.url()})`
      );
    }

    const href = await declLink.evaluate((el) => (el as HTMLAnchorElement).href);
    console.log(`[aaa] 'Auto Declaration Page' href: ${href}`);

    const suffix = policyId ?? "declarations";
    let pdfBytes: Buffer;

    // Blob URLs must be fetched in the documents-page context (before/at click)
    if (href.startsWith("blob:")) {
      console.log("[aaa] Fetching blob PDF from documents page…");
      try {
        const base64Data = await workingPage.evaluate(async (blobUrl) => {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result.split(",")[1] ?? "");
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, href);
        pdfBytes = Buffer.from(base64Data, "base64");
        console.log(`[aaa] Fetched blob PDF (${pdfBytes.length} bytes)`);
      } catch (err) {
        console.warn(`[aaa] Blob fetch failed (${err}) — trying click + new tab…`);
        pdfBytes = await this.downloadPdfViaClick(browser, workingPage, declLink, href, suffix);
      }
    } else {
      pdfBytes = await this.downloadPdfViaClick(browser, workingPage, declLink, href, suffix);
    }

    return [
      {
        type: "policy",
        filename: `auto-declaration-${suffix}.pdf`,
        mimeType: "application/pdf",
        data: pdfBytes,
      },
    ];
  }

  /** Click Auto Declaration link (target=_blank) and fetch PDF bytes */
  private async downloadPdfViaClick(
    browser: Browser,
    workingPage: Page,
    declLink: ElementHandle<Element>,
    href: string,
    _suffix: string
  ): Promise<Buffer> {
    const pagesBefore = await AaaCarrier.safeBrowserPages(browser);

    console.log("[aaa] Clicking 'Auto Declaration Page'…");
    await declLink.click();
    await sleep(2_000);

    const pdfTab = await AaaCarrier.waitForNewPage(browser, pagesBefore, 10_000).catch(
      () => null
    );

    const workingTab = pdfTab ?? workingPage;
    const finalUrl = pdfTab ? AaaCarrier.safeUrl(pdfTab) : href;
    console.log(`[aaa] PDF target URL: ${finalUrl}`);

    await workingTab
      .waitForNavigation({ waitUntil: "networkidle0", timeout: NAV_TIMEOUT })
      .catch(() => {});

    try {
      console.log(`[aaa] Fetching PDF bytes at: ${finalUrl}`);
      const base64Data = await workingPage.evaluate(async (url) => {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1] ?? "");
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, finalUrl);

      const pdfBytes = Buffer.from(base64Data, "base64");
      console.log(`[aaa] Successfully fetched PDF (${pdfBytes.length} bytes)`);
      return pdfBytes;
    } catch (err) {
      console.warn(`[aaa] Failed to fetch PDF directly: ${err}. Falling back to print-to-PDF…`);
      const printBytes = await workingTab.pdf({ format: "Letter" });
      return Buffer.from(printBytes);
    }
  }

  // ─── Okta helpers ──────────────────────────────────────────────────────────

  private async findOktaTab(browser: Browser): Promise<Page | null> {
    return AaaCarrier.findOktaTab(browser);
  }

  /** Pick the live mypolicy tab (not about:blank) */
  private static async resolveActiveMypolicyTab(
    browser: Browser,
    fallback: Page
  ): Promise<Page> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      const url = AaaCarrier.safeUrl(tab);
      if (url === "about:blank") continue;
      if (
        url.includes("mypolicy.csaa-insurance.aaa.com") ||
        url.includes("mypolicyclub.digital.csaa-insurance.aaa.com") ||
        url.includes(".okta.com")
      ) {
        return tab;
      }
    }
    return fallback;
  }

  private static async hasPoliciesDashboard(browser: Browser): Promise<boolean> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      const url = AaaCarrier.safeUrl(tab);
      if (!url.includes("/policies") || url.includes("policy-zip")) continue;
      const found = await tab.$(SEL_VIEW_DETAILS).catch(() => null);
      if (found) return true;
    }
    return false;
  }

  /** True when any tab has left the zip gate */
  private static async hasLeftZipGate(browser: Browser): Promise<boolean> {
    if (await AaaCarrier.hasPoliciesDashboard(browser)) {
      console.log("[aaa] Policies dashboard visible");
      return true;
    }

    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      try {
        const url = AaaCarrier.safeUrl(tab);
        if (url.includes("policy-zip") || url.includes("manage-mypolicy")) {
          continue;
        }
        if (url.includes("mypolicy.csaa-insurance.aaa.com")) {
          console.log(`[aaa] Left zip gate → ${url}`);
          return true;
        }
      } catch {
        /* detached tab */
      }
    }
    return false;
  }

  /**
   * Dismiss the "Continue to my AAA club" interstitial dialog on any open tab.
   * This modal appears after zip gate submission and blocks the /policies page.
   */
  private static async dismissClubInterstitial(browser: Browser): Promise<void> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      try {
        const btn = await tab.$(SEL_CLUB_INTERSTITIAL).catch(() => null);
        if (btn) {
          console.log(`[aaa] Dismissing 'Continue to my AAA club' interstitial on ${AaaCarrier.safeUrl(tab)}`);
          await btn.click();
          await sleep(1_000);
          return;
        }
      } catch {
        /* detached tab — skip */
      }
    }
  }

  private static async findPolicyZipTab(browser: Browser): Promise<Page | null> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      const url = AaaCarrier.safeUrl(tab);
      if (url.includes("policy-zip") || url.includes("manage-mypolicy")) {
        return tab;
      }
    }
    return null;
  }

  /** Poll until View details appears on any tab */
  private static async waitForPoliciesDashboard(
    browser: Browser,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await AaaCarrier.hasLeftZipGate(browser)) {
        await AaaCarrier.waitForViewDetails(browser, 10_000).catch(() => {});
        return;
      }
      await sleep(500);
    }
    throw new Error("AAA: Timed out waiting for policies dashboard after zip gate");
  }

  private static async waitForViewDetails(
    browser: Browser,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        const found = await tab
          .waitForSelector(SEL_VIEW_DETAILS, { visible: true, timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
        if (found) return;
      }
      await sleep(300);
    }
  }

  private static async findOktaTab(browser: Browser): Promise<Page | null> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      if (await AaaCarrier.isOktaPageStatic(tab)) return tab;
    }
    return null;
  }

  /** Poll until an Okta tab appears (redirect after /policies is often delayed) */
  private static async waitForOktaTab(
    browser: Browser,
    timeoutMs: number
  ): Promise<Page | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await AaaCarrier.findOktaTab(browser);
      if (tab) return tab;
      await sleep(500);
    }
    return null;
  }

  /** After goto /policies, wait for either Okta redirect or policies page */
  private static async waitForOktaOrPolicyClub(
    browser: Browser,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await AaaCarrier.findOktaTab(browser)) {
        console.log("[aaa] Navigation settled on Okta");
        return;
      }
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        const url = AaaCarrier.safeUrl(tab);
        if (
          url.includes("/policies") ||
          url.includes("policy-zip") ||
          url.includes("manage-mypolicy")
        ) {
          console.log(`[aaa] Navigation settled on Policy Club: ${url}`);
          return;
        }
      }
      await sleep(500);
    }
    console.log("[aaa] Navigation settle timeout — continuing");
  }

  private async isOktaPage(tab: Page): Promise<boolean> {
    return AaaCarrier.isOktaPageStatic(tab);
  }

  private static async isOktaPageStatic(tab: Page): Promise<boolean> {
    if (tab.isClosed()) return false;
    const url = tab.url();
    if (/\.okta\.com/i.test(url)) return true;

    // Check for Okta widget in the page content (may be embedded in iframe)
    try {
      const hasWidget = await tab.evaluate(() => {
        return !!(
          document.querySelector('#okta-sign-in') ||
          document.querySelector('input[value="Send me the code"]') ||
          document.querySelector('input[name="answer"]') ||
          document.querySelector('input[name="credentials.passcode"]')
        );
      });
      if (hasWidget) return true;

      // Also check iframes
      for (const frame of tab.frames()) {
        try {
          const frameHasWidget = await frame.evaluate(() => {
            return !!(
              document.querySelector('#okta-sign-in') ||
              document.querySelector('input[value="Send me the code"]') ||
              document.querySelector('input[name="answer"]')
            );
          });
          if (frameHasWidget) return true;
        } catch { /* detached */ }
      }
    } catch { /* closed */ }

    return false;
  }

  private async waitForOktaWidget(tab: Page): Promise<void> {
    console.log("[aaa] Waiting for Okta widget…");

    // Ensure JS enabled
    await tab.setJavaScriptEnabled(true).catch(() => {});
    const cdp = await tab.createCDPSession().catch(() => null);
    await cdp?.send("Emulation.setScriptExecutionDisabled", { value: false }).catch(() => {});

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const found = await tab.evaluate(() => {
        return !!(
          document.querySelector('#okta-sign-in') ||
          document.querySelector('input[value="Send me the code"]') ||
          document.querySelector('input[name="answer"]')
        );
      }).catch(() => false);

      if (found) {
        console.log("[aaa] Okta widget found");
        return;
      }

      // Try frames
      for (const frame of tab.frames()) {
        try {
          const found = await frame.evaluate(() => {
            return !!(
              document.querySelector('#okta-sign-in') ||
              document.querySelector('input[value="Send me the code"]') ||
              document.querySelector('input[name="answer"]')
            );
          });
          if (found) {
            console.log("[aaa] Okta widget found in iframe");
            return;
          }
        } catch { /* detached */ }
      }
      await sleep(500);
    }

    // Reload and try again
    console.log("[aaa] Reloading Okta page to ensure JS is active…");
    await tab.reload({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await tab
      .waitForSelector(
        '#okta-sign-in, input[value="Send me the code"], input[name="answer"]',
        { timeout: 15_000 }
      )
      .catch(() => {});
  }

  private async hasCodeInput(tab: Page): Promise<boolean> {
    for (const ctx of this.allContexts(tab)) {
      const el = await ctx.$(SEL_OKTA_CODE_INPUT).catch(() => null);
      if (el) return true;
    }
    return false;
  }

  private async clickSendCode(tab: Page): Promise<void> {
    for (const ctx of this.allContexts(tab)) {
      const btn = await ctx.$(SEL_OKTA_SEND_CODE).catch(() => null);
      if (btn) {
        await btn.click();
        await sleep(2_000);
        return;
      }
    }
    throw new Error("AAA: Could not find 'Send me the code' button on Okta");
  }

  private async waitForCodeInput(tab: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const ctx of AaaCarrier.liveContexts(tab)) {
        const el = await ctx.$(SEL_OKTA_CODE_INPUT).catch(() => null);
        if (el) return;
      }
      await sleep(300);
    }
    throw new Error("AAA: Timed out waiting for Okta code input field");
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
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      const tab =
        (await AaaCarrier.findOktaTab(browser)) ??
        (tabHint.isClosed() ? null : tabHint);

      if (!tab) {
        console.log(`[aaa] Okta submit attempt ${attempt}: no Okta tab yet`);
        await sleep(400);
        continue;
      }

      await tab.bringToFront().catch(() => {});
      await tab.setJavaScriptEnabled(true).catch(() => {});

      try {
        // Ensure the passcode field is present before filling (fresh each attempt)
        await AaaCarrier.waitForOktaInputVisible(tab, 5_000);

        if (await AaaCarrier.fillAndVerifyOktaInTab(tab, safeCode)) {
          console.log(`[aaa] Okta code submitted on attempt ${attempt}`);
          await tab
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: NAV_TIMEOUT,
            })
            .catch(() => {});
          await sleep(2_000);
          console.log(`[aaa] After verify, URL: ${AaaCarrier.safeUrl(tab)}`);
          return;
        }

        console.log(
          `[aaa] Okta submit attempt ${attempt} failed — ${await AaaCarrier.oktaPageDebugHint(tab)}`
        );
      } catch (err) {
        if (!AaaCarrier.isDetachedError(err)) throw err;
        console.log(`[aaa] Okta submit attempt ${attempt}: detached frame, retrying…`);
      }

      await sleep(400);
    }

    const lastTab =
      (await AaaCarrier.findOktaTab(browser)) ??
      (tabHint.isClosed() ? null : tabHint);
    const hint = lastTab
      ? await AaaCarrier.oktaPageDebugHint(lastTab)
      : "Okta tab closed";

    throw new Error(
      `AAA: Could not submit Okta code (tab: ${AaaCarrier.safeUrl(tabHint)}). ${hint}`
    );
  }

  private static async waitForOktaInputVisible(
    tab: Page,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const ctx of AaaCarrier.oktaSubmitContexts(tab)) {
        const el = await ctx
          .$(`${SEL_OKTA_ANSWER}, ${SEL_OKTA_CODE_INPUT}`)
          .catch(() => null);
        if (el) return;
      }
      await sleep(200);
    }
  }

  /** Main page first — AAA uses full-page Okta at csaainsurance.okta.com */
  private static oktaSubmitContexts(tab: Page): OktaCtx[] {
    const childFrames: Frame[] = [];
    for (const frame of tab.frames()) {
      try {
        void frame.url();
        if (frame !== tab.mainFrame()) childFrames.push(frame);
      } catch {
        /* detached */
      }
    }
    return [tab, ...childFrames];
  }

  private static async fillAndVerifyOktaInTab(
    tab: Page,
    otp: string
  ): Promise<boolean> {
    // 1. Explicit AAA selectors on main page (input[name="answer"] + Verify)
    for (const ctx of AaaCarrier.oktaSubmitContexts(tab)) {
      try {
        if (await AaaCarrier.fillOktaViaExplicitEvaluate(ctx, otp)) return true;
      } catch (err) {
        if (!AaaCarrier.isDetachedError(err)) throw err;
      }
    }

    // 2. Puppeteer typing (fresh handles, same attempt)
    for (const ctx of AaaCarrier.oktaSubmitContexts(tab)) {
      try {
        if (await AaaCarrier.fillOktaViaPuppeteer(ctx, otp)) return true;
      } catch (err) {
        if (!AaaCarrier.isDetachedError(err)) throw err;
      }
    }

    return false;
  }

  /** AAA Okta email verify — form #form32, input[name="answer"], Verify button */
  private static async fillOktaViaExplicitEvaluate(
    ctx: OktaCtx,
    otp: string
  ): Promise<boolean> {
    return ctx.evaluate((code) => {
      const input =
        (document.querySelector('input[name="answer"]') as HTMLInputElement | null) ??
        (document.querySelector('input[name="credentials.passcode"]') as HTMLInputElement | null);

      if (!input || input.disabled || input.type === "hidden") return false;

      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      if (setter) setter.call(input, code);
      else input.value = code;

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const verify =
        (document.querySelector('input[value="Verify"]') as HTMLInputElement | null) ??
        (document.querySelector('input[data-type="save"][value="Verify"]') as HTMLInputElement | null);

      if (verify) {
        verify.click();
        return true;
      }

      const form =
        (document.querySelector("#form32") as HTMLFormElement | null) ??
        input.closest("form");
      form?.requestSubmit();
      return true;
    }, otp);
  }

  private static async oktaPageDebugHint(tab: Page): Promise<string> {
    try {
      return await tab.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input")).map((el) => {
          const input = el as HTMLInputElement;
          return `${input.type}:${input.name}:${input.id}:${input.disabled}`;
        });
        const buttons = Array.from(
          document.querySelectorAll("input[type='submit'], button")
        ).map((el) =>
          (
            (el as HTMLInputElement).value ||
            (el as HTMLButtonElement).innerText ||
            ""
          ).trim()
        );
        return `inputs=[${inputs.join("; ")}] buttons=[${buttons.join("; ")}]`;
      });
    } catch {
      return "Could not read Okta DOM";
    }
  }

  /** Type into passcode field like a user when evaluate cannot see the node. */
  private static async fillOktaViaPuppeteer(
    ctx: OktaCtx,
    otp: string
  ): Promise<boolean> {
    const input = await ctx
      .waitForSelector(`${SEL_OKTA_ANSWER}, ${SEL_OKTA_CODE_INPUT}`, {
        visible: true,
        timeout: 8_000,
      })
      .catch(() => null);

    if (!input) return false;

    await input.click({ count: 3 });
    await input.evaluate((el) => {
      (el as HTMLInputElement).value = "";
    });
    await input.type(otp, { delay: 50 });

    const typed = await input
      .evaluate((el) => (el as HTMLInputElement).value)
      .catch(() => "");
    if (!typed) return false;

    console.log(`[aaa] Okta code typed via Puppeteer (${typed.length} chars)`);

    const verify = await ctx.$(SEL_OKTA_VERIFY).catch(() => null);
    if (verify) {
      await verify.click();
      return true;
    }

    await input.press("Enter");
    return true;
  }

  private static isDetachedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /detached Frame|Execution context was destroyed|Cannot find context|Navigating frame was detached/i.test(
      msg
    );
  }

  private static safeUrl(tab: Page): string {
    try {
      return tab.url();
    } catch {
      return "(closed)";
    }
  }

  /** Wait until any tab leaves Okta and lands on policy club */
  private static async waitForPostOktaRedirect(
    browser: Browser,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
        const url = AaaCarrier.safeUrl(tab);
        if (/\.okta\.com/i.test(url)) continue;
        if (
          url.includes("mypolicy.csaa-insurance.aaa.com") ||
          url.includes("mypolicyclub.digital.csaa-insurance.aaa.com") ||
          url.includes("policy-zip") ||
          url.includes("manage-mypolicy")
        ) {
          console.log(`[aaa] Post-Okta redirect detected: ${url}`);
          return;
        }
      }
      await sleep(500);
    }
    console.log("[aaa] Post-Okta redirect not detected within timeout — continuing");
  }

  /** Pick a live tab for navigation — never return a detached page */
  private static async resolveLivePolicyTab(
    browser: Browser,
    fallback: Page
  ): Promise<Page> {
    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      try {
        const url = AaaCarrier.safeUrl(tab);
        if (/\.okta\.com/i.test(url)) continue;
        if (
          url.includes("mypolicy") ||
          url.includes("csaa-insurance.aaa.com") ||
          url.includes("mwg.aaa.com")
        ) {
          void tab.url(); // throws if detached
          return tab;
        }
      } catch {
        /* detached — try next tab */
      }
    }

    for (const tab of await AaaCarrier.safeBrowserPages(browser)) {
      try {
        void tab.url();
        if (!tab.isClosed()) return tab;
      } catch {
        /* detached */
      }
    }

    return await browser.newPage();
  }

  private static async safeGoto(tab: Page, url: string): Promise<Page> {
    let target = tab;
    try {
      void tab.url();
    } catch {
      target = await AaaCarrier.resolveLivePolicyTab(tab.browser(), tab);
    }

    try {
      await target.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return target;
    } catch (err) {
      if (!AaaCarrier.isDetachedError(err)) throw err;
      const fresh = await AaaCarrier.resolveLivePolicyTab(tab.browser(), tab);
      await fresh.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return fresh;
    }
  }

  /** Child frames first — Okta often renders the form in an iframe, not the top document. */
  private static liveContexts(tab: Page): OktaCtx[] {
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

    return [...childFrames, tab];
  }

  /** Returns all live contexts: child frames first, then the main page */
  private allContexts(tab: Page): OktaCtx[] {
    return AaaCarrier.liveContexts(tab);
  }

  // ─── Policy tab helpers ────────────────────────────────────────────────────

  /** Find the tab that is on the policy club domain (prefer /policies or /policy/) */
  private async getPoliciesTab(browser: Browser, fallback: Page): Promise<Page> {
    if (this.policyClubTab && !this.policyClubTab.isClosed()) {
      return this.policyClubTab;
    }

    const tabs = await AaaCarrier.safeBrowserPages(browser);
    const policyClub = tabs.filter((tab) => {
      const url = tab.url();
      return (
        url.includes("mypolicy.csaa-insurance.aaa.com") ||
        url.includes("mypolicyclub.digital.csaa-insurance.aaa.com")
      );
    });

    for (const tab of policyClub) {
      const url = tab.url();
      if (url.includes("/policy/") || url.includes("/policies")) return tab;
    }

    if (policyClub.length > 0) return policyClub[0];
    return fallback;
  }

  // ─── Static utilities ───────────────────────────────────────────────────────

  private static async safeBrowserPages(browser: Browser): Promise<Page[]> {
    try {
      const pages = await browser.pages();
      return pages.filter((tab) => {
        try { return !tab.isClosed(); } catch { return false; }
      });
    } catch {
      return [];
    }
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
    throw new Error("AAA: Timed out waiting for new browser tab");
  }

  private static creds(
    credentials: Record<string, string>
  ): { email: string; password: string } {
    const { email, password } = credentials;
    if (!email) throw new Error("AaaCarrier: missing credential 'email'");
    if (!password) throw new Error("AaaCarrier: missing credential 'password'");
    return { email, password };
  }

  // ─── Required stubs for fetchDocuments (used by finalizeDocuments) ──────────
  protected async fetchDocuments(_page: Page): Promise<DocumentResult["documents"]> {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
