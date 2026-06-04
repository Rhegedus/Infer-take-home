import puppeteer, { Browser, Page } from "puppeteer-core";
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

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
 *  - Owns the Browserless CDP session lifecycle
 *  - Drives the Redis-backed state machine
 *  - Runs the async MFA polling loop
 *  - Delegates carrier-specific logic to concrete subclasses
 *
 * Subclasses MUST implement:
 *  - `carrierId`          – unique string identifier (e.g. "cigna", "aetna")
 *  - `login(page)`        – navigate to the portal and authenticate
 *  - `triggerMfa(page)`   – initiate MFA challenge on the portal
 *  - `submitMfa(page, code)` – type/submit the MFA code in the browser
 *  - `fetchDocuments(page)`  – scrape / download documents after auth
 */
export abstract class BaseCarrier {
  abstract readonly carrierId: string;

  protected readonly store: SessionStore;
  protected readonly config: Required<CarrierConfig>;

  private browser: Browser | null = null;

  constructor(redis: Redis, config: CarrierConfig) {
    const merged: Required<CarrierConfig> = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.config = merged;
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
    const page = await this.openBrowser();

    // 1. Login
    this.log(sessionId, "Logging in…");
    await this.login(page, credentials);

    // 2. Trigger MFA (carrier-specific — may be a no-op for some carriers)
    this.log(sessionId, "Triggering MFA challenge…");
    await this.store.transition(sessionId, CarrierState.AWAITING_MFA);
    await this.triggerMfa(page);

    // 3. Poll Redis until the user submits their MFA code
    const mfaCode = await this.awaitMfaCode(sessionId);

    // 4. Submit the code in the browser
    this.log(sessionId, "Submitting MFA code…");
    await this.store.transition(sessionId, CarrierState.MFA_SUBMITTED);
    await this.submitMfaInBrowser(page, mfaCode);

    // 5. Fetch documents
    this.log(sessionId, "Fetching documents…");
    await this.store.transition(sessionId, CarrierState.FETCHING_DOCS);
    const documents = await this.fetchDocuments(page);

    // 6. Complete
    await this.store.transition(sessionId, CarrierState.COMPLETED);
    this.log(sessionId, `Completed — ${documents.length} document(s) extracted`);

    return {
      sessionId,
      carrierId: this.carrierId,
      documents,
      completedAt: Date.now(),
    };
  }

  // ─── MFA Polling Loop ─────────────────────────────────────────────────────────

  /**
   * Polls Redis every `mfaPollIntervalMs` until a code appears or timeout fires.
   * Uses `GETDEL` (via SessionStore.consumeMfa) so the code is consumed once.
   */
  private async awaitMfaCode(sessionId: string): Promise<string> {
    const deadline = Date.now() + this.config.mfaTimeoutMs;
    this.log(
      sessionId,
      `Awaiting MFA — polling every ${this.config.mfaPollIntervalMs}ms, ` +
        `timeout in ${this.config.mfaTimeoutMs / 1_000}s`
    );

    while (Date.now() < deadline) {
      const code = await this.store.consumeMfa(sessionId);

      if (code) {
        this.log(sessionId, "MFA code received");
        return code;
      }

      await sleep(this.config.mfaPollIntervalMs);
    }

    throw new Error(
      `MFA timeout: no code received within ${this.config.mfaTimeoutMs / 1_000}s`
    );
  }

  // ─── Browser Lifecycle ────────────────────────────────────────────────────────

  private async openBrowser(): Promise<Page> {
    this.browser = await puppeteer.connect({
      browserWSEndpoint: this.config.browserlessWsEndpoint,
    });

    const page = await this.browser.newPage();

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
      await this.store.transition(sessionId, CarrierState.FAILED, { error });
    } catch {
      // Don't mask the original error if the transition itself fails
    }
    this.log(sessionId, `FAILED — ${error}`);
  }

  // ─── Logging ──────────────────────────────────────────────────────────────────

  protected log(sessionId: string, message: string): void {
    console.log(`[${this.carrierId}][${sessionId}] ${message}`);
  }

  // ─── Abstract Interface ───────────────────────────────────────────────────────

  /**
   * Optional hook: configure page-level settings (headers, cookies, etc.)
   * before the login flow begins. No-op by default.
   */
  protected async configurePage(_page: Page): Promise<void> {}

  /** Navigate to the carrier portal and authenticate with `credentials`. */
  protected abstract login(
    page: Page,
    credentials: Record<string, string>
  ): Promise<void>;

  /**
   * Trigger the MFA challenge on the portal (e.g. click "Send Code").
   * Implement as a no-op if the carrier sends the code automatically.
   */
  protected abstract triggerMfa(page: Page): Promise<void>;

  /** Type and submit the MFA code in the browser UI. */
  protected abstract submitMfaInBrowser(page: Page, code: string): Promise<void>;

  /** Scrape or download documents after successful authentication. */
  protected abstract fetchDocuments(page: Page): Promise<DocumentResult["documents"]>;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
