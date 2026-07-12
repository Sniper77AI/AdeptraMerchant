import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Stage 2's onboarding Server Action imports merchant/ucp/pipeline.ts
  // directly (the analysis pipeline — no npm package boundary, it's plain
  // zero-dependency TS source) — that's a sibling directory OUTSIDE
  // dashboard/, which Turbopack refuses to resolve unless the root is
  // widened to the repo root. See onboarding/actions.ts's header comment.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
