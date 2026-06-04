/**
 * @module carriers
 *
 * Multi-carrier insurance document extraction framework.
 *
 * ## Architecture
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Next.js App Router                                             │
 * │                                                                 │
 * │  POST /api/carriers/mfa  ──► SessionStore.submitMfa(code)       │
 * │                                      │                          │
 * │                                      ▼ Redis key                │
 * │  BaseCarrier.run()                                              │
 * │    │                                                            │
 * │    ├─ openBrowser()  ──► Browserless CDP (WebSocket)            │
 * │    ├─ login()        ──► Subclass impl                          │
 * │    ├─ triggerMfa()   ──► Subclass impl                          │
 * │    ├─ awaitMfaCode() ──► polls Redis every N ms                 │
 * │    ├─ submitMfa()    ──► Subclass impl                          │
 * │    └─ fetchDocuments()──► Subclass impl                         │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ## State Machine
 *
 *  INITIALIZED
 *      │
 *      ▼
 *  AWAITING_MFA  ◄──────────────────┐
 *      │                            │ (retry)
 *      ▼                            │
 *  MFA_SUBMITTED ───────────────────┘
 *      │
 *      ▼
 *  FETCHING_DOCS
 *      │
 *      ▼
 *  COMPLETED
 *
 *  (any state) ──► FAILED
 *
 * ## Adding a new carrier
 *
 * 1. Create `lib/carriers/impl/{carrier-id}-carrier.ts`
 * 2. `extends BaseCarrier`
 * 3. Implement the five abstract methods
 * 4. Register in your carrier registry / factory
 */

export { BaseCarrier } from "./base-carrier";
export { SessionStore } from "./session-store";
export * from "./types";
