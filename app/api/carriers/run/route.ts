import { NextRequest, NextResponse, after } from "next/server";
import { Redis } from "@upstash/redis";
import { AaaCarrier } from "@/lib/carriers/impl/aaa-carrier";
import { LemonadeCarrier } from "@/lib/carriers/impl/lemonade-carrier";
import { BaseCarrier } from "@/lib/carriers/base-carrier";

export const maxDuration = 300; // Allow execution up to 5 minutes on Vercel

const redis = Redis.fromEnv();
const WS    = process.env.BROWSERLESS_WS_ENDPOINT ?? "";

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

  // Instantiate carrier per session to prevent state conflicts
  let carrier: BaseCarrier;
  if (carrierId === "aaa") {
    carrier = new AaaCarrier(redis, { browserlessWsEndpoint: WS });
  } else if (carrierId === "lemonade") {
    carrier = new LemonadeCarrier(redis, { browserlessWsEndpoint: WS });
  } else {
    return NextResponse.json(
      {
        error: `Unknown carrier "${carrierId}". ` +
               `Valid options: aaa, lemonade`,
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
  // This maintains your existing, stable session lifecycle.
  const { sessionId, promise } = await carrier.start(credentials);

  console.log(`[run][${sessionId}] Registering background execution via after()`);

  // Keep the Vercel context alive until the background browser execution completes.
  after(async () => {
    console.log(`[after][${sessionId}] Starting background execution...`);
    try {
      await promise;
      console.log(`[after][${sessionId}] Background execution complete.`);
    } catch (err) {
      console.error(`[after][${sessionId}] background job failed:`, err);
    }
  });

  return NextResponse.json({ ok: true, sessionId }, { status: 202 });
}