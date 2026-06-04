import puppeteer, { Browser, Page } from "puppeteer-core";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

import { browserlessWsWithLaunch } from "../browserless-endpoint";
import { SessionStore } from "./session-store";
import {
  CarrierConfig,
  CarrierSession,
  CarrierState,
  DEFAULT_CONFIG,
  DocumentResult,
} from "./types";

/**
 * BaseCarrier
 * -----------
 * Abstract base class for all insurance carrier extractors.
 *
 * Responsibilities:
 * - Owns the Browserless CDP session lifecycle
 * - Drives the Redis-backed state machine
 * - Runs the async MFA polling loop
 * - Delegates carrier-specific logic to concrete subclasses
 *
 * Subclasses MUST implement:
 * - `carrierId`          – unique string identifier (e.g. "cigna", "aetna")
 * - `login(page)`        – navigate to the portal and authenticate
 * - `detectMfa(page)`    – return true when an OTP/MFA screen is showing (may send code)
 * - `navigateToDocumentsArea(page)` – post-auth navigation toward policy documents
 * - `submitMfa(page, code)` – type/submit the MFA code in the browser
 * - `fetchDocuments(page)`  – scrape / download documents after auth
 */
export abstract class BaseCarrier {
  abstract readonly carrierId: string;

  protected readonly store: SessionStore;
  protected readonly config: Required<CarrierConfig>;
  protected readonly redis: Redis;

  private browser: Browser | null = null;
  private currentSessionId: string | null = null;

  constructor(redis: Redis, config: CarrierConfig) {
    const merged: Required<CarrierConfig> = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.config = merged;
    this.redis = redis;
    this.store = new SessionStore(redis, merged.sessionTtlSec);
  }

  // ─── Public Entry Points ──────────────────────────────────────────────────────

  /**
   * Allocates a session ID and writes the INITIALIZED record to Redis,
   * then kicks off the extraction in the background.
   *
   * Returns the sessionId immediately so callers can hand it to the frontend
   * before any browser work begins — the frontend polls
   * GET /api/carriers/mfa?sessionId=… for state updates.
   */
  async start(credentials: Record<string, string>): Promise<string> {
    const sessionId = randomUUID();

    const session: CarrierSession = {
      sessionId,
      carrierId: this.carrierId,
      state: CarrierState.INITIALIZED,
      statusMessage: "Starting session…",
      updatedAt: Date.now(),
    };

    await this.store.create(session);
    this.log(sessionId, "Session created");

    // Run the extraction pipeline asynchronously; errors are captured into Redis.
    this.run(sessionId, credentials).catch((err) => {
      console.error(`[${this.carrierId}][${sessionId}] Fatal:`, err);
    });

    return sessionId;
  }

  /**
   * Full synchronous extraction run — useful for testing or server-side awaiting.
   * Prefer `start()` in API routes so the HTTP response is not held open.
   */
  async run(sessionId: string, credentials: Record<string, string>): Promise<DocumentResult> {
    try {
      return await this.execute(sessionId, credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failSession(sessionId, message);
      throw err;
    } finally {
      await this.closeBrowser();
    }
  }

  // ─── Core Execution Pipeline ──────────────────────────────────────────────────

  private async execute(
    sessionId: string,
    credentials: Record<string, string>
  ): Promise<DocumentResult> {
    this.currentSessionId = sessionId;
    try {
      return await this.runPipeline(sessionId, credentials);
    } finally {
      this.currentSessionId = null;
    }
  }

  /** Override in subclasses that need a linear step flow (e.g. AAA). */
  protected async runPipeline(
    sessionId: string,
    credentials: Record<string, string>
  ): Promise<DocumentResult> {
    this.resetCarrierState();

    await this.progress("Launching secure browser…");
    const page = await this.openBrowser();

    await this.progress(this.signInStatusMessage());
    await this.login(page, credentials);

    await this.progress(this.postSignInCheckMessage());
    await this.resolveMfaCheckpoints(sessionId, page);

    do {
      await this.progress(this.navigateToDocumentsMessage());
      await this.navigateToDocumentsArea(page);
      await this.progress(this.postNavigationCheckMessage());
      await this.resolveMfaCheckpoints(sessionId, page);
    } while (await this.navigationPending(page));

    const documents = await this.fetchDocumentsWithTransition(sessionId, page);
    return this.finalizeDocuments(sessionId, documents);
  }

  protected async fetchDocumentsWithTransition(
    sessionId: string,
    page: Page
  ): Promise<DocumentResult["documents"]> {
    await this.store.transition(sessionId, CarrierState.FETCHING_DOCS, {
      statusMessage: this.fetchDocumentsMessage(),
    });
    return this.fetchDocuments(page);
  }

  protected async finalizeDocuments(
    sessionId: string,
    documents: DocumentResult["documents"]
  ): Promise<DocumentResult> {
    if (documents.length > 0) {
      const base64String = documents[0].data.toString("base64");
      await this.progress("Preparing document for download…");
      return this.redis
        .set(`document:${sessionId}`, base64String, { ex: 3600 })
        .then(() => this.completeSession(sessionId, documents));
    }
    return this.completeSession(sessionId, documents);
  }

  private async completeSession(
    sessionId: string,
    documents: DocumentResult["documents"]
  ): Promise<DocumentResult> {
    await this.store.transition(sessionId, CarrierState.COMPLETED, {
      statusMessage: `Done — ${documents.length} document(s) ready`,
    });
    this.log(sessionId, `Completed — ${documents.length} document(s) extracted`);

    return {
      sessionId,
      carrierId: this.carrierId,
      documents,
      completedAt: Date.now(),
    };
  }

  // ─── MFA Polling Loop ─────────────────────────────────────────────────────────

  /** Max OTP rounds per checkpoint (login vs. post-navigation). */
  private static readonly MAX_MFA_ROUNDS = 5;

  /**
   * Repeatedly detects MFA, waits for the user code, and submits until clear
   * or `MAX_MFA_ROUNDS` is exceeded.
   */
  private async resolveMfaCheckpoints(
    sessionId: string,
    page: Page
  ): Promise<void> {
    for (let round = 0; round < BaseCarrier.MAX_MFA_ROUNDS; round++) {
      const requiresMfa = await this.detectMfa(page);

      if (!requiresMfa) {
        if (round === 0) {
          await this.progress("No additional verification needed — continuing…");
        }
        return;
      }

      await this.store.transition(sessionId, CarrierState.AWAITING_MFA, {
        statusMessage: this.mfaAwaitingMessage(round),
      });

      const mfaCode = await this.awaitMfaCode(sessionId);

      await this.store.transition(sessionId, CarrierState.MFA_SUBMITTED, {
        statusMessage: "Submitting verification code…",
      });
      await this.submitMfaInBrowser(page, mfaCode);
      await this.afterMfaSubmit(page);
    }

    throw new Error(
      `Exceeded maximum MFA rounds (${BaseCarrier.MAX_MFA_ROUNDS})`
    );
  }

  /**
   * Polls Redis every `mfaPollIntervalMs` until a code appears or timeout fires.
   * Uses `GETDEL` (via SessionStore.consumeMfa) so the code is consumed once.
   */
  protected async awaitMfaCode(sessionId: string): Promise<string> {
    const deadline = Date.now() + this.config.mfaTimeoutMs;
    await this.progress("Waiting for you to enter your verification code…");

    while (Date.now() < deadline) {
      const code = await this.store.consumeMfa(sessionId);

      if (code) {
        await this.progress("Code received — verifying…");
        return code;
      }

      await sleep(this.config.mfaPollIntervalMs);
    }

    throw new Error(
      `MFA timeout: no code received within ${this.config.mfaTimeoutMs / 1_000}s`
    );
  }

  // ─── Browser Lifecycle ────────────────────────────────────────────────────────

  protected async openBrowser(): Promise<Page> {
    const wsEndpoint = browserlessWsWithLaunch(this.config.browserlessWsEndpoint);

    this.browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
    });

    const page = await this.browser.newPage();

    await page.setJavaScriptEnabled(true);
    await page
      .createCDPSession()
      .then((cdp) =>
        cdp.send("Emulation.setScriptExecutionDisabled", { value: false })
      )
      .catch(() => {});

    // Reasonable defaults — subclasses can override via `configurePage`
    await page.setViewport({ width: 1_280, height: 900 });
    await page.setDefaultNavigationTimeout(60_000);
    await this.configurePage(page);

    return page;
  }

  private async closeBrowser(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Best-effort — the remote session may already be gone
    } finally {
      this.browser = null;
    }
  }

  // ─── Error Helpers ────────────────────────────────────────────────────────────

  private async failSession(sessionId: string, error: string): Promise<void> {
    try {
      await this.store.transition(sessionId, CarrierState.FAILED, {
        error,
        statusMessage: error,
      });
    } catch {
      // Don't mask the original error if the transition itself fails
    }
    this.log(sessionId, `FAILED — ${error}`);
  }

  // ─── Logging & UI status ─────────────────────────────────────────────────────

  protected log(sessionId: string, message: string): void {
    console.log(`[${this.carrierId}][${sessionId}] ${message}`);
  }

  /** Writes a detailed status line to Redis for the polling UI. */
  protected async progress(message: string): Promise<void> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    this.log(sessionId, message);
    await this.store.patchStatus(sessionId, message);
  }

  // ─── Abstract Interface ───────────────────────────────────────────────────────

  /**
   * Optional hook: configure page-level settings (headers, cookies, etc.)
   * before the login flow begins. No-op by default.
   */
  protected async configurePage(_page: Page): Promise<void> {}

  /** Reset per-run instance state (subclasses with navigation flags). */
  protected resetCarrierState(): void {}

  /** Return true when navigateToDocumentsArea must run again (e.g. after MFA). */
  protected async navigationPending(_page: Page): Promise<boolean> {
    return false;
  }

  /** Optional hook after each MFA submission (e.g. wait for navigation). */
  protected async afterMfaSubmit(_page: Page): Promise<void> {}

  /** Status line while paused for the user OTP (round is 0-based). */
  protected mfaAwaitingMessage(round: number): string {
    return round === 0
      ? "Verification required — enter the code we sent you"
      : `Verification required again (step ${round + 1}) — enter your code`;
  }

  protected signInStatusMessage(): string {
    return "Signing in to carrier portal…";
  }

  protected postSignInCheckMessage(): string {
    return "Checking for security verification after sign-in…";
  }

  protected navigateToDocumentsMessage(): string {
    return "Navigating to your policy documents…";
  }

  protected postNavigationCheckMessage(): string {
    return "Checking for security verification on policy site…";
  }

  protected fetchDocumentsMessage(): string {
    return "Downloading policy declarations…";
  }

  /** Navigate to the carrier portal and authenticate with `credentials`. */
  protected abstract login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void>;

  /**
   * Return true when an OTP/MFA screen is visible on the active page.
   * Implementations may click "Send code" before returning true.
   */
  protected abstract detectMfa(page: Page): Promise<boolean>;

  /**
   * Navigate from the post-login view to where policy documents live.
   * No-op for carriers that land on the dashboard immediately after MFA.
   */
  protected abstract navigateToDocumentsArea(page: Page): Promise<void>;

  /** Type and submit the MFA code in the browser UI. */
  protected abstract submitMfaInBrowser(page: Page, code: string): Promise<void>;

  /** Scrape or download documents after successful authentication. */
  protected abstract fetchDocuments(page: Page): Promise<DocumentResult["documents"]>;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}