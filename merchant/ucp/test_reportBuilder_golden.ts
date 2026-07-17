/**
 * Golden-fixture regression lock for reportBuilder.ts/reportModel.ts.
 * Captures buildBundlePlan()'s full output (report_markdown + report_html +
 * files[]) for four representative RunBundleData shapes and verifies
 * byte-for-byte equality on every subsequent run. Same discipline as
 * test_pageChecks_golden.ts / test_signal_values_golden.ts.
 *
 * Cases:
 *  - complete / no_manifest / multi_file: originally captured for the Stage-3
 *    reportModel.ts extraction (proving a pure refactor changed WHERE the
 *    model lives, not WHAT it renders) — kept as an ongoing regression lock.
 *  - with_advisory: added 2026-07-13 alongside the new
 *    ucp_signing_keys_present signal and PillarSection's `advisories` bucket
 *    — proves a not_applicable signal WITH a merchant_note surfaces as a
 *    "Worth knowing" advisory instead of silently vanishing (see explicit
 *    content assertions below; this is genuinely NEW captured content, not a
 *    must-stay-identical case like the other three). Confirmed the OTHER
 *    three cases stayed byte-identical after adding the advisories bucket —
 *    empty advisories render nothing.
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

// Added 2026-07-13 alongside ucp_signing_keys_present: proves a not_applicable
// signal WITH a merchant_note surfaces as a "Worth knowing" advisory (added to
// PillarSection — see reportModel.ts) rather than silently vanishing, the way
// every OTHER not_applicable signal without a note still does (no advisory
// entry is added for those, unchanged behavior).
const WITH_ADVISORY_DATA: RunBundleData = {
  ...COMPLETE_DATA,
  signals: [
    ...COMPLETE_DATA.signals,
    {
      signal_key: "ucp_signing_keys_present",
      pillar: "ucp",
      category: "discovery_manifest",
      status: "not_applicable",
      weight: 1,
      priority_score: 0,
      fix_summary: null,
      basis: "specified",
      merchant_note: "Signed requests/responses let an AI shopping agent cryptographically verify a payload genuinely came from your store. Recommended for stores that want verifiable agent interactions.",
    },
  ],
};

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
    with_advisory: buildBundlePlan(WITH_ADVISORY_DATA),
  };
  const serialized = JSON.stringify(cases, null, 2);

  // Explicit content assertions for the advisory case — a byte-diff alone
  // doesn't self-document WHY this case exists; these make the intent
  // checkable without decoding the captured JSON.
  let advisoryChecksFailed = 0;
  const advisoryCheck = (name: string, cond: boolean) => {
    console.log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) advisoryChecksFailed++;
  };
  const advisoryPlan = cases.with_advisory;
  advisoryCheck("advisory: markdown shows 'Worth knowing' section", advisoryPlan.report_markdown.includes("### Worth knowing"));
  advisoryCheck("advisory: markdown shows the signal_key and merchant_note", advisoryPlan.report_markdown.includes("ucp_signing_keys_present") && advisoryPlan.report_markdown.includes("Recommended for stores that want verifiable agent interactions"));
  advisoryCheck("advisory: html shows 'Worth knowing' heading", advisoryPlan.report_html.includes("Worth knowing"));
  advisoryCheck("advisory: html shows the signal_key and merchant_note", advisoryPlan.report_html.includes("ucp_signing_keys_present") && advisoryPlan.report_html.includes("Recommended for stores that want verifiable agent interactions"));
  advisoryCheck("advisory: the OTHER three cases (no advisory signals) show no 'Worth knowing' section", !cases.complete.report_markdown.includes("Worth knowing") && !cases.no_manifest.report_markdown.includes("Worth knowing") && !cases.multi_file.report_markdown.includes("Worth knowing"));
  if (advisoryChecksFailed > 0) {
    console.error(`❌ ${advisoryChecksFailed} advisory content check(s) failed.`);
    process.exit(1);
  }

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
