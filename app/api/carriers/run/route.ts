import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { AaaCarrier } from "@/lib/carriers/impl/aaa-carrier";
import { LemonadeCarrier } from "@/lib/carriers/impl/lemonade-carrier";
import { BaseCarrier } from "@/lib/carriers/base-carrier";

const redis = Redis.fromEnv();
const WS    = process.env.BROWSERLESS_WS_ENDPOINT ?? "";

/**
 * Registry — add carriers here as they are implemented.
 * Instantiated once at module load; BaseCarrier holds no per-session state.
 */
const CARRIERS: Record<string, BaseCarrier> = {
  aaa:      new AaaCarrier(redis,      { browserlessWsEndpoint: WS }),
  lemonade: new LemonadeCarrier(redis, { browserlessWsEndpoint: WS }),
};

/**
 * POST /api/carriers/run
 *
 * Body: { carrierId: "aaa" | "lemonade"; credentials: Record<string, string> }
 *
 * 1. Allocates a session in Redis and returns the sessionId immediately (202).
 * 2. Kicks off the Browserless automation in the background.
 * 3. The frontend polls GET /api/carriers/mfa?sessionId=… to track state.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  if (!body?.carrierId || !body?.credentials) {
    return NextResponse.json(
      { error: "carrierId and credentials are required" },
      { status: 400 }
    );
  }

  const { carrierId, credentials } = body as {
    carrierId:   string;
    credentials: Record<string, string>;
  };

  const carrier = CARRIERS[carrierId];

  if (!carrier) {
    return NextResponse.json(
      {
        error: `Unknown carrier "${carrierId}". ` +
               `Valid options: ${Object.keys(CARRIERS).join(", ")}`,
      },
      { status: 422 }
    );
  }

  if (!WS) {
    return NextResponse.json(
      { error: "BROWSERLESS_WS_ENDPOINT env var is not configured" },
      { status: 503 }
    );
  }

  // start() writes INITIALIZED to Redis, fires the pipeline in the background,
  // and returns the sessionId before any browser work begins.
  const sessionId = await carrier.start(credentials);

  return NextResponse.json({ ok: true, sessionId }, { status: 202 });
}
