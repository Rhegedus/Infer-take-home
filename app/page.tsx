"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type CarrierId = "aaa" | "lemonade";

type SessionState =
  | "INITIALIZED"
  | "AWAITING_MFA"
  | "MFA_SUBMITTED"
  | "FETCHING_DOCS"
  | "COMPLETED"
  | "FAILED";

interface CarrierSession {
  sessionId:  string;
  carrierId:  string;
  state:      SessionState;
  error?:     string;
  updatedAt:  number;
}

interface Carrier {
  id:          CarrierId;
  label:       string;
  needsPassword: boolean;
  mfaLabel:    string;
  mfaHint:     string;
  color:       string;
}

// ─── Carrier Registry ─────────────────────────────────────────────────────────

const CARRIERS: Carrier[] = [
  {
    id:            "aaa",
    label:         "AAA",
    needsPassword: true,
    mfaLabel:      "SMS Code",
    mfaHint:       "Enter the 6-digit code texted to your phone",
    color:         "#003DA5",
  },
  {
    id:            "lemonade",
    label:         "Lemonade",
    needsPassword: false,
    mfaLabel:      "Email OTP",
    mfaHint:       "Enter the 6-digit code sent to your email",
    color:         "#FF0083",
  },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_500;

const STATE_LABELS: Record<SessionState, string> = {
  INITIALIZED:   "Starting session…",
  AWAITING_MFA:  "Waiting for your code",
  MFA_SUBMITTED: "Verifying code…",
  FETCHING_DOCS: "Fetching documents…",
  COMPLETED:     "Done",
  FAILED:        "Failed",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Page() {
  const [carrierId, setCarrierId]     = useState<CarrierId>("aaa");
  const [email, setEmail]             = useState("");
  const [password, setPassword]       = useState("");
  const [mfaCode, setMfaCode]         = useState("");
  const [sessionId, setSessionId]     = useState<string | null>(null);
  const [session, setSession]         = useState<CarrierSession | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [mfaSending, setMfaSending]   = useState(false);
  const [formError, setFormError]     = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  const carrier = CARRIERS.find((c) => c.id === carrierId)!;

  // ─── Polling ──────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollSession = useCallback(async (sid: string) => {
    try {
      const res  = await fetch(`/api/carriers/mfa?sessionId=${sid}`);
      const data = await res.json() as CarrierSession;
      setSession(data);

      if (data.state === "AWAITING_MFA") {
        stopPolling();
        // Focus the MFA input as soon as it appears
        setTimeout(() => mfaInputRef.current?.focus(), 100);
      }

      if (data.state === "COMPLETED" || data.state === "FAILED") {
        stopPolling();
      }
    } catch {
      // Network blip — keep polling
    }
  }, [stopPolling]);

  const startPolling = useCallback((sid: string) => {
    stopPolling();
    pollRef.current = setInterval(() => pollSession(sid), POLL_INTERVAL_MS);
  }, [pollSession, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSession(null);
    setSessionId(null);
    setMfaCode("");
    setSubmitting(true);

    const credentials: Record<string, string> = { email };
    if (carrier.needsPassword) credentials.password = password;

    try {
      const res  = await fetch("/api/carriers/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ carrierId, credentials }),
      });
      const data = await res.json();

      if (!res.ok || !data.sessionId) {
        setFormError(data.error ?? "Failed to start session.");
        return;
      }

      setSessionId(data.sessionId);
      startPolling(data.sessionId);
    } catch {
      setFormError("Network error — could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || mfaCode.length < 6) return;
    setMfaSending(true);

    try {
      const res  = await fetch("/api/carriers/mfa", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ sessionId, code: mfaCode }),
      });
      const data = await res.json();

      if (!res.ok) {
        setFormError(data.error ?? "Failed to submit code.");
        return;
      }

      // Resume polling so the UI tracks MFA_SUBMITTED → FETCHING_DOCS → COMPLETED
      startPolling(sessionId);
    } catch {
      setFormError("Network error — could not submit code.");
    } finally {
      setMfaSending(false);
    }
  }

  // ─── Derived state ────────────────────────────────────────────────────────

  const isRunning    = !!sessionId && session?.state !== "COMPLETED" && session?.state !== "FAILED";
  const awaitingMfa  = session?.state === "AWAITING_MFA";
  const isCompleted  = session?.state === "COMPLETED";
  const isFailed     = session?.state === "FAILED";
  const progressState: SessionState[] = ["INITIALIZED", "AWAITING_MFA", "MFA_SUBMITTED", "FETCHING_DOCS", "COMPLETED"];
  const progressIdx  = session ? progressState.indexOf(session.state) : -1;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <main style={styles.root}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={styles.header}>
        <div style={{ ...styles.headerAccent, background: carrier.color }} />
        <h1 style={styles.title}>DocExtract</h1>
        <p style={styles.subtitle}>Insurance document retrieval</p>
      </header>

      {/* ── Credential Form ─────────────────────────────────────────────── */}
      {!isRunning && !isCompleted && (
        <section style={styles.card}>
          <form onSubmit={handleStart} style={styles.form}>

            {/* Carrier selector */}
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Carrier</legend>
              <div style={styles.radioGroup}>
                {CARRIERS.map((c) => (
                  <label
                    key={c.id}
                    style={{
                      ...styles.radioLabel,
                      ...(carrierId === c.id ? { ...styles.radioLabelActive, borderColor: c.color } : {}),
                    }}
                  >
                    <input
                      type="radio"
                      name="carrier"
                      value={c.id}
                      checked={carrierId === c.id}
                      onChange={() => { setCarrierId(c.id); setFormError(null); }}
                      style={{ display: "none" }}
                    />
                    <span
                      style={{
                        ...styles.radioSwatch,
                        background: c.color,
                      }}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Email */}
            <label style={styles.label}>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                style={styles.input}
                autoComplete="email"
              />
            </label>

            {/* Password — hidden for passwordless carriers */}
            {carrier.needsPassword && (
              <label style={styles.label}>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={styles.input}
                  autoComplete="current-password"
                />
              </label>
            )}

            {!carrier.needsPassword && (
              <p style={styles.hint}>
                {carrier.label} is passwordless — a one-time code will be sent to your email after you submit.
              </p>
            )}

            {formError && <p style={styles.error}>{formError}</p>}

            <button
              type="submit"
              disabled={submitting}
              style={{ ...styles.btn, background: carrier.color }}
            >
              {submitting ? "Starting…" : "Start Extraction"}
            </button>
          </form>
        </section>
      )}

      {/* ── Progress Tracker ────────────────────────────────────────────── */}
      {isRunning && (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>Session Progress</h2>

          {/* Step strip */}
          <div style={styles.stepStrip}>
            {progressState.map((s, i) => {
              const done    = i < progressIdx;
              const current = i === progressIdx;
              return (
                <div key={s} style={styles.stepItem}>
                  <div
                    style={{
                      ...styles.stepDot,
                      background: done ? "#22c55e"
                                : current ? carrier.color
                                : "#e2e8f0",
                      boxShadow: current ? `0 0 0 4px ${carrier.color}33` : "none",
                    }}
                  >
                    {done && <span style={styles.checkmark}>✓</span>}
                    {current && <span style={styles.pulse} />}
                  </div>
                  {i < progressState.length - 1 && (
                    <div
                      style={{
                        ...styles.stepLine,
                        background: done ? "#22c55e" : "#e2e8f0",
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Status label */}
          {session && (
            <p style={styles.statusLabel}>
              {STATE_LABELS[session.state]}
            </p>
          )}

          {/* Session ID (for debugging) */}
          <p style={styles.sessionId}>
            Session: <code>{sessionId}</code>
          </p>
        </section>
      )}

      {/* ── MFA Entry ───────────────────────────────────────────────────── */}
      {awaitingMfa && (
        <section style={{ ...styles.card, borderColor: carrier.color }}>
          <h2 style={{ ...styles.sectionTitle, color: carrier.color }}>
            Action Required — Enter Your {carrier.mfaLabel}
          </h2>
          <p style={styles.hint}>{carrier.mfaHint}</p>

          <form onSubmit={handleMfaSubmit} style={styles.form}>
            <input
              ref={mfaInputRef}
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              required
              style={styles.otpInput}
              autoComplete="one-time-code"
            />

            {formError && <p style={styles.error}>{formError}</p>}

            <button
              type="submit"
              disabled={mfaSending || mfaCode.length < 6}
              style={{
                ...styles.btn,
                background: mfaCode.length === 6 ? carrier.color : "#94a3b8",
                cursor: mfaCode.length === 6 ? "pointer" : "not-allowed",
              }}
            >
              {mfaSending ? "Submitting…" : "Submit Code"}
            </button>
          </form>
        </section>
      )}

      {/* ── Completed ───────────────────────────────────────────────────── */}
      {isCompleted && (
        <section style={{ ...styles.card, borderColor: "#22c55e", maxWidth: 800 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <div style={{ ...styles.successIcon, marginBottom: 0 }}>✓</div>
            <div>
              <h2 style={{ ...styles.sectionTitle, color: "#16a34a", marginBottom: 4 }}>
                Documents Retrieved
              </h2>
              <p style={styles.hint}>
                Your {carrier.label} documents have been successfully extracted.
              </p>
            </div>
          </div>

          <iframe
            src={`/api/carriers/document?sessionId=${sessionId}`}
            style={{ width: "100%", height: 600, border: "1.5px solid #e2e8f0", borderRadius: 8, marginBottom: 24, background: "#f8fafc" }}
            title="Policy Document"
          />

          <button
            style={{ ...styles.btn, background: "#64748b", width: "100%" }}
            onClick={() => {
              setSession(null);
              setSessionId(null);
              setEmail("");
              setPassword("");
              setMfaCode("");
              setFormError(null);
            }}
          >
            Start New Extraction
          </button>
        </section>
      )}

      {/* ── Failed ──────────────────────────────────────────────────────── */}
      {isFailed && (
        <section style={{ ...styles.card, borderColor: "#ef4444" }}>
          <h2 style={{ ...styles.sectionTitle, color: "#dc2626" }}>
            Extraction Failed
          </h2>
          {session?.error && (
            <pre style={styles.errorPre}>{session.error}</pre>
          )}
          <button
            style={{ ...styles.btn, background: "#64748b", marginTop: 16 }}
            onClick={() => {
              setSession(null);
              setSessionId(null);
              setFormError(null);
            }}
          >
            Try Again
          </button>
        </section>
      )}
    </main>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Inline styles keep the component self-contained with no CSS module dependency.

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight:       "100vh",
    background:      "#f8fafc",
    display:         "flex",
    flexDirection:   "column",
    alignItems:      "center",
    padding:         "40px 16px 80px",
    fontFamily:      "'IBM Plex Mono', 'Fira Code', 'Courier New', monospace",
    color:           "#0f172a",
  },
  header: {
    width:           "100%",
    maxWidth:        480,
    marginBottom:    32,
    position:        "relative",
    paddingLeft:     16,
  },
  headerAccent: {
    position:        "absolute",
    left:            0,
    top:             4,
    bottom:          4,
    width:           4,
    borderRadius:    2,
    transition:      "background 0.3s",
  },
  title: {
    margin:          0,
    fontSize:        28,
    fontWeight:      700,
    letterSpacing:   "-0.5px",
  },
  subtitle: {
    margin:          "4px 0 0",
    fontSize:        13,
    color:           "#64748b",
    letterSpacing:   "0.05em",
    textTransform:   "uppercase",
  },
  card: {
    width:           "100%",
    maxWidth:        480,
    background:      "#ffffff",
    border:          "1.5px solid #e2e8f0",
    borderRadius:    12,
    padding:         "28px 28px 24px",
    marginBottom:    20,
    boxShadow:       "0 1px 3px rgba(0,0,0,0.06)",
    transition:      "border-color 0.3s, max-width 0.3s ease-in-out",
  },
  form: {
    display:         "flex",
    flexDirection:   "column",
    gap:             16,
  },
  fieldset: {
    border:          "none",
    padding:         0,
    margin:          0,
  },
  legend: {
    fontSize:        12,
    fontWeight:      600,
    letterSpacing:   "0.08em",
    textTransform:   "uppercase",
    color:           "#64748b",
    marginBottom:    10,
  },
  radioGroup: {
    display:         "flex",
    gap:             10,
  },
  radioLabel: {
    display:         "flex",
    alignItems:      "center",
    gap:             8,
    padding:         "10px 16px",
    borderWidth:     "1.5px",
    borderStyle:     "solid",
    borderColor:     "#e2e8f0",
    borderRadius:    8,
    cursor:          "pointer",
    fontSize:        14,
    fontWeight:      500,
    transition:      "border-color 0.2s, background 0.2s",
    userSelect:      "none",
    flex:            1,
    justifyContent:  "center",
  },
  radioLabelActive: {
    background:      "#f8fafc",
  },
  radioSwatch: {
    width:           10,
    height:          10,
    borderRadius:    "50%",
    flexShrink:      0,
  },
  label: {
    display:         "flex",
    flexDirection:   "column",
    gap:             6,
    fontSize:        12,
    fontWeight:      600,
    letterSpacing:   "0.06em",
    textTransform:   "uppercase",
    color:           "#475569",
  },
  input: {
    padding:         "10px 12px",
    border:          "1.5px solid #e2e8f0",
    borderRadius:    8,
    fontSize:        14,
    fontFamily:      "inherit",
    outline:         "none",
    transition:      "border-color 0.2s",
    background:      "#fafafa",
    color:           "#0f172a",
  },
  otpInput: {
    padding:         "14px 16px",
    border:          "1.5px solid #e2e8f0",
    borderRadius:    8,
    fontSize:        28,
    fontFamily:      "inherit",
    letterSpacing:   "0.3em",
    textAlign:       "center",
    outline:         "none",
    background:      "#fafafa",
    color:           "#0f172a",
    width:           "100%",
    boxSizing:       "border-box",
  },
  btn: {
    padding:         "12px 20px",
    border:          "none",
    borderRadius:    8,
    color:           "#ffffff",
    fontSize:        14,
    fontWeight:      600,
    fontFamily:      "inherit",
    cursor:          "pointer",
    letterSpacing:   "0.04em",
    transition:      "opacity 0.2s",
  },
  hint: {
    fontSize:        13,
    color:           "#64748b",
    margin:          0,
    lineHeight:      1.6,
  },
  error: {
    fontSize:        13,
    color:           "#dc2626",
    background:      "#fef2f2",
    border:          "1px solid #fecaca",
    borderRadius:    6,
    padding:         "8px 12px",
    margin:          0,
  },
  errorPre: {
    fontSize:        12,
    color:           "#dc2626",
    background:      "#fef2f2",
    border:          "1px solid #fecaca",
    borderRadius:    6,
    padding:         "10px 12px",
    overflowX:       "auto",
    whiteSpace:      "pre-wrap",
    wordBreak:       "break-all",
  },
  sectionTitle: {
    margin:          "0 0 16px",
    fontSize:        16,
    fontWeight:      700,
    letterSpacing:   "-0.2px",
  },
  stepStrip: {
    display:         "flex",
    alignItems:      "center",
    marginBottom:    16,
  },
  stepItem: {
    display:         "flex",
    alignItems:      "center",
    flex:            1,
  },
  stepDot: {
    width:           24,
    height:          24,
    borderRadius:    "50%",
    flexShrink:      0,
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    position:        "relative",
    transition:      "background 0.3s, box-shadow 0.3s",
  },
  checkmark: {
    fontSize:        12,
    color:           "#ffffff",
    fontWeight:      700,
  },
  pulse: {
    position:        "absolute",
    inset:           -4,
    borderRadius:    "50%",
    border:          "2px solid currentColor",
    opacity:         0.4,
    animation:       "none",
  },
  stepLine: {
    flex:            1,
    height:          2,
    transition:      "background 0.3s",
  },
  statusLabel: {
    fontSize:        14,
    fontWeight:      500,
    color:           "#334155",
    margin:          "0 0 8px",
  },
  sessionId: {
    fontSize:        11,
    color:           "#94a3b8",
    margin:          0,
    wordBreak:       "break-all",
  },
  successIcon: {
    width:           48,
    height:          48,
    borderRadius:    "50%",
    background:      "#dcfce7",
    color:           "#16a34a",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    fontSize:        22,
    fontWeight:      700,
    marginBottom:    16,
  },
};