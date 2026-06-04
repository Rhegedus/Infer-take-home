// ─── Carrier Session State Machine ────────────────────────────────────────────

export const CarrierState = {
  INITIALIZED:   "INITIALIZED",
  AWAITING_MFA:  "AWAITING_MFA",
  MFA_SUBMITTED: "MFA_SUBMITTED",
  FETCHING_DOCS: "FETCHING_DOCS",
  COMPLETED:     "COMPLETED",
  FAILED:        "FAILED",
} as const;

export type CarrierState = (typeof CarrierState)[keyof typeof CarrierState];

/** Legal transitions — anything else throws */
export const VALID_TRANSITIONS: Record<CarrierState, CarrierState[]> = {
  INITIALIZED:   ["AWAITING_MFA", "FETCHING_DOCS", "FAILED"],
  AWAITING_MFA:  ["MFA_SUBMITTED", "FAILED"],
  MFA_SUBMITTED: ["FETCHING_DOCS", "AWAITING_MFA", "FAILED"],
  FETCHING_DOCS: ["COMPLETED", "FAILED"],
  COMPLETED:     [],
  FAILED:        [],
};

// ─── Session Envelope ──────────────────────────────────────────────────────────

export interface CarrierSession {
  sessionId:      string;
  carrierId:      string;
  state:          CarrierState;
  /** Human-readable step detail shown in the UI while this state is active. */
  statusMessage?: string;
  mfaCode?:       string;
  error?:         string;
  updatedAt:      number; // unix ms
}

// ─── Extraction Result ─────────────────────────────────────────────────────────

export interface DocumentResult {
  sessionId:  string;
  carrierId:  string;
  documents:  ExtractedDocument[];
  completedAt: number;
}

export interface ExtractedDocument {
  type:      string;   // e.g. "EOB", "ID_CARD", "POLICY"
  filename:  string;
  mimeType:  string;
  data:      Buffer;
}

// ─── Carrier Config ────────────────────────────────────────────────────────────

export interface CarrierConfig {
  /** Milliseconds between Redis polls when awaiting MFA */
  mfaPollIntervalMs?: number;
  /** Max wall-clock time to wait for MFA before failing (ms) */
  mfaTimeoutMs?: number;
  /** Browserless WebSocket endpoint */
  browserlessWsEndpoint: string;
  /** Session TTL in Redis (seconds) */
  sessionTtlSec?: number;
}

export const DEFAULT_CONFIG: Required<Omit<CarrierConfig, "browserlessWsEndpoint">> = {
  mfaPollIntervalMs: 3_000,
  mfaTimeoutMs:      300_000, // 5 min
  sessionTtlSec:     3_600,   // 1 hr
};
