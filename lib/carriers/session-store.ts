import { Redis } from "@upstash/redis";
import {
  CarrierSession,
  CarrierState,
  VALID_TRANSITIONS,
} from "./types";

/**
 * Thin, typed wrapper around Upstash Redis for carrier session management.
 * All keys are namespaced under `carrier:session:{sessionId}`.
 */
export class SessionStore {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(redis: Redis, ttlSec: number) {
    this.redis = redis;
    this.ttlSec = ttlSec;
  }

  // ─── Key Helpers ─────────────────────────────────────────────────────────────

  private sessionKey(sessionId: string) {
    return `carrier:session:${sessionId}`;
  }

  private mfaKey(sessionId: string) {
    return `carrier:mfa:${sessionId}`;
  }

  // ─── Session CRUD ─────────────────────────────────────────────────────────────

  async create(session: CarrierSession): Promise<void> {
    await this.redis.set(
      this.sessionKey(session.sessionId),
      session, // Let Upstash handle stringify
      { ex: this.ttlSec }
    );
  }

  async get(sessionId: string): Promise<CarrierSession | null> {
    const session = await this.redis.get<CarrierSession>(this.sessionKey(sessionId));
    return session || null; // Let Upstash handle parsing
  }

  /**
   * Update the live status line without changing the state machine phase.
   */
  async patchStatus(sessionId: string, statusMessage: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      console.log(`[SessionStore][${sessionId}] patchStatus failed: session not found`);
      return;
    }

    console.log(
      `[SessionStore][${sessionId}] patchStatus: "${session.statusMessage}" -> "${statusMessage}" (state: ${session.state})`
    );

    await this.redis.set(
      this.sessionKey(sessionId),
      { ...session, statusMessage, updatedAt: Date.now() },
      { ex: this.ttlSec }
    );
  }

  /**
   * Atomically validate and apply a state transition.
   * Throws if the transition is not permitted by the state machine.
   */
  async transition(
    sessionId: string,
    nextState: CarrierState,
    patch: Partial<Omit<CarrierSession, "sessionId" | "carrierId" | "state">> = {}
  ): Promise<CarrierSession> {
    const session = await this.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    console.log(
      `[SessionStore][${sessionId}] transition attempt: ${session.state} -> ${nextState}`
    );

    if (session.state === nextState) {
      console.log(
        `[SessionStore][${sessionId}] transition act as patch for self-transition: ${session.state} -> ${nextState}`
      );
      const updated: CarrierSession = {
        ...session,
        ...patch,
        updatedAt: Date.now(),
      };
      await this.redis.set(this.sessionKey(sessionId), updated, { ex: this.ttlSec });
      return updated;
    }

    const allowed = VALID_TRANSITIONS[session.state];
    if (!allowed.includes(nextState)) {
      throw new Error(
        `Invalid transition ${session.state} → ${nextState} for session ${sessionId}`
      );
    }

    const updated: CarrierSession = {
      ...session,
      ...patch,
      state: nextState,
      updatedAt: Date.now(),
    };

    await this.redis.set(
      this.sessionKey(sessionId),
      updated, // Let Upstash handle stringify
      { ex: this.ttlSec }
    );

    console.log(
      `[SessionStore][${sessionId}] transition success: ${session.state} -> ${nextState} (status: "${updated.statusMessage}")`
    );

    return updated;
  }

  // ─── MFA Slot ─────────────────────────────────────────────────────────────────

  /**
   * Write an MFA code into a short-lived Redis key.
   * Called externally (e.g. from an API route) when the user submits their token.
   */
  async submitMfa(sessionId: string, code: string, ttlSec = 120): Promise<void> {
    console.log(`[SessionStore][${sessionId}] submitMfa code: ${code}`);
    await this.redis.set(this.mfaKey(sessionId), code, { ex: ttlSec });
  }

  /**
   * Consume (GETDEL) the MFA code — ensures it is used exactly once.
   */
  async consumeMfa(sessionId: string): Promise<string | null> {
    const code = await this.redis.getdel<string>(this.mfaKey(sessionId));
    if (code) {
      console.log(`[SessionStore][${sessionId}] consumeMfa success, code found`);
    }
    return code;
  }
}
