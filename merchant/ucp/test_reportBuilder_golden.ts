/**
 * Golden-fixture regression lock for the reportModel.ts extraction (Stage 3):
 * proves moving the pure model (buildModel/buildSections/pillar display names/
 * etc.) out of reportBuilder.ts into its own module changed WHERE that logic
 * lives, not WHAT it renders. Captures buildBundlePlan()'s full output
 * (report_markdown + report_html + files[]) for three representative
 * RunBundleData shapes — a normal complete run, a no_manifest run (the
 * "hasn't started UCP" framing), and a multi-file-tree artifact (mcp_scaffold)
 * — before touching reportBuilder.ts, then verifies byte-for-byte equality
 * after. Same discipline as test_pageChecks_golden.ts / test_signal_values_golden.ts.
 *
 * Usage:
 *   node --experimental-strip-types test_reportBuilder_golden.ts capture
 *   node --experimental-strip-types test_reportBuilder_golden.ts verify
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildBundlePlan, type RunBundleData } from "./export/reportBuilder.ts";
import { encodeFileTree } from "./artifacts/types.ts";

const FIXTURE_PATH = new URL("./__fixtures__/reportBuilder_golden.json", import.meta.url);

const COMPLETE_DATA: RunBundleData = {
  runId: "11111111-1111-1111-1111-111111111111",
  siteId: "22222222-2222-2222-2222-222222222222",
  domain: "shop.example.com",
  status: "complete",
  createdAt: "2026-07-06T12:00:00.000Z",
  pillars: [
    { pillar: "ucp", score: 84.46, signals_passed: 15, signals_total: 20 },
    { pillar: "agent_readability", score: 92.5, signals_passed: 9, signals_total: 10 },
  ],
  signals: [
    { signal_key: "ucp_manifest_present", pillar: "ucp", category: "discovery_manifest", status: "pass", weight: 3, priority_score: 7.5, fix_summary: null, basis: null, merchant_note: null },
    { signal_key: "capability_cart_declared", pillar: "ucp", category: "capabilities", status: "fail", weight: 2, priority_score: 2.67, fix_summary: "Declare dev.ucp.shopping.cart in ucp.capabilities to support multi-item carts.", basis: null, merchant_note: null },
    { signal_key: "ucp_namespace_authority_valid", pillar: "ucp", category: "discovery_manifest", status: "partial", weight: 1, priority_score: 9.0, fix_summary: "Some spec/schema URLs are not on the canonical UCP authority.", basis: null, merchant_note: null },
    { signal_key: "robots_txt_valid", pillar: "agent_readability", category: "crawler_access", status: "pass", weight: 1.5, priority_score: 4.5, fix_summary: null, basis: "specified", merchant_note: null },
    { signal_key: "llms_txt_present", pillar: "agent_readability", category: "discovery_surfaces", status: "fail", weight: 0.5, priority_score: 2.0, fix_summary: "No llms.txt found.", basis: "contested", merchant_note: "llms.txt has no established effect on AI citation visibility." },
  ],
  artifacts: [
    {
      artifact_type: "ucp_manifest",
      target_url: "/.well-known/ucp",
      content: JSON.stringify({ ucp: { version: "2026-04-08" } }, null, 2),
      changelog: {
        added: ['ucp.version = "2026-04-08"'],
        corrected: [],
        must_complete: ["Replace the placeholder shopping service endpoint with your real UCP endpoint URL."],
        flagged: ["Add dev.ucp.common.identity_linking only if you support account-linked experiences — not added automatically."],
      },
      resolves_signal_ids: ["abc-123"],
    },
  ],
};

const NO_MANIFEST_DATA: RunBundleData = { ...COMPLETE_DATA, status: "no_manifest" };

const MULTI_FILE_DATA: RunBundleData = {
  ...COMPLETE_DATA,
  artifacts: [
    ...COMPLETE_DATA.artifacts,
    {
      artifact_type: "mcp_scaffold",
      target_url: "mcp-server",
      content: encodeFileTree([
        { path: "index.js", contents: "// scaffold entry point\n" },
        { path: "package.json", contents: '{"name":"mcp-server"}' },
      ]),
      changelog: { added: ["Scaffolded a WooCommerce MCP shopping server."], corrected: [], must_complete: [], flagged: [] },
      resolves_signal_ids: [],
    },
  ],
};

function main() {
  const mode = process.argv[2];
  if (mode !== "capture" && mode !== "verify") {
    console.error("Usage: node --experimental-strip-types test_reportBuilder_golden.ts <capture|verify>");
    process.exit(2);
  }

  const cases = {
    complete: buildBundlePlan(COMPLETE_DATA),
    no_manifest: buildBundlePlan(NO_MANIFEST_DATA),
    multi_file: buildBundlePlan(MULTI_FILE_DATA),
  };
  const serialized = JSON.stringify(cases, null, 2);

  if (mode === "capture") {
    writeFileSync(FIXTURE_PATH, serialized + "\n");
    console.log(`✅ Captured golden fixture -> ${FIXTURE_PATH.pathname}`);
    return;
  }

  if (!existsSync(FIXTURE_PATH)) {
    console.error(`❌ No fixture found at ${FIXTURE_PATH.pathname} — run with 'capture' first.`);
    process.exit(1);
  }
  const expected = readFileSync(FIXTURE_PATH, "utf8").trimEnd();
  const actual = serialized;
  if (actual === expected) {
    console.log("✅ buildBundlePlan output (complete / no_manifest / multi_file) is byte-identical to the golden fixture.");
    process.exit(0);
  } else {
    console.error("❌ buildBundlePlan output DIFFERS from the golden fixture.");
    const expectedCases = JSON.parse(expected);
    for (const key of Object.keys(cases)) {
      const a = JSON.stringify((cases as any)[key]);
      const e = JSON.stringify(expectedCases[key]);
      if (a !== e) console.error(`--- ${key} differs ---`);
    }
    process.exit(1);
  }
}

main();
