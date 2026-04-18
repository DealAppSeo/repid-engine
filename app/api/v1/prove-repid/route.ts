import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const { agent_id, requester_pubkey, requested_tier } = await req.json();
  return NextResponse.json({
    proof: "mock-proof",
    tier: requested_tier || "postcard",
    payload: {},
    repid_score: 0
  });
}
