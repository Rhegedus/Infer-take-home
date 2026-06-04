import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

// Initialize Upstash Redis Client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return new NextResponse("Missing sessionId", { status: 400 });
  }

  try {
    const base64String = await redis.get<string>(`document:${sessionId}`);

    if (!base64String) {
      return new NextResponse("Document not found or expired", { status: 404 });
    }

    const pdfBuffer = Buffer.from(base64String, "base64");

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="policy-${sessionId}.pdf"`,
      },
    });
  } catch (error) {
    console.error(`[API Error] Failed to fetch document for session ${sessionId}:`, error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}