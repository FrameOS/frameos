import { NextResponse } from "next/server";
import { fontListResponse } from "../../../src/lib/fonts";

export const runtime = "nodejs";

// The font catalogue, in the shape the shared SPA's fontsModel expects from a
// self-hosted backend ({fonts: FontMetadata[]}). Until this existed, apiFetch
// answered /api/fonts locally with an empty list in cloud mode, and the scene
// editor's font picker had nothing in it.
//
// Unauthenticated on purpose: this is the fixed list of faces FrameOS ships,
// identical for every account and public in the repo. The bytes it names are
// served straight out of public/fonts, so gating the metadata would protect
// nothing.
export function GET() {
  return NextResponse.json(fontListResponse());
}
