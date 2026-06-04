import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { SessionStore } from "@/lib/carriers/session-store";
import { CarrierState } from "@/lib/carriers/types";

const redis = Redis.fromEnv();
const store = new SessionStore(redis, 3_600);

/**
 * GET /api/carriers/mfa?sessionId=…
 *
 * Polled by the frontend to read the current session state.
 * Returns the full CarrierSession envelope so the UI can react to
 * AWAITING_MFA, COMPLETED, FAILED, etc. without a separate /session route.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId query param is required" },
      { status: 400 }
    );
  }

  const session = await store.get(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session);
}

/**
 * POST /api/carriers/mfa
 *
 * Body: { sessionId: string; code: string }
 *
 * Called by the frontend when the user submits their OTP.
 * Writes the code to the Redis MFA slot so the BaseCarrier polling loop picks it up.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  if (!body?.sessionId || !body?.code) {
    return NextResponse.json(
      { error: "sessionId and code are required" },
      { status: 400 }
    );
  }

  const { sessionId, code } = body as { sessionId: string; code: string };

  const session = await store.get(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.state !== CarrierState.AWAITING_MFA) {
    return NextResponse.json(
      { error: `Session is not awaiting MFA (current state: ${session.state})` },
      { status: 409 }
    );
  }

  await store.submitMfa(sessionId, code);

  return NextResponse.json({ ok: true, sessionId });
}
