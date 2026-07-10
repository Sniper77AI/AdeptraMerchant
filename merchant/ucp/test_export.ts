/**
 * Tests for the export pipeline (mock-driven, no network/DB).
 *
 * 1. reportBuilder purity/determinism.
 * 2. no_manifest run: "hasn't started UCP" framing, never a punitive 0%.
 * 3. Prioritized plan: failing/partial signals ordered by priority_score desc.
 * 4. Artifact coverage: every artifact appears in report_html and files[];
 *    must_complete items surface in the report.
 * 5. Future-proofing: an unknown artifact_type ("storefront_theme_patch") is
 *    included without error or a reportBuilder rewrite.
 * 6. Placeholder contract: report_html contains exactly one
 *    {{BUNDLE_DOWNLOAD_URL}} token before substitution.
 * 7. Bundle file list: report.md / report.html / README.txt + one file per
 *    artifact with the expected derived name.
 * 8. ZIP round-trip: an independent minimal reader confirms buildZip's bytes
 *    decode back to the exact same file list (verifies the hand-rolled format).
 * 9. Multi-file artifact expansion: a file-tree artifact (mcp_scaffold's real
 *    shape) expands into a subfolder in files[] — every file present, exact
 *    contents, report shows the file list, and the whole subtree round-trips
 *    through the real ZIP writer.
 *
 * Run: node --experimental-strip-types test_export.ts
 */

import { buildBundlePlan, BUNDLE_DOWNLOAD_URL_TOKEN, typeDisplayName, type RunBundleData } from "./export/reportBuilder.ts";
import { encodeFileTree } from "./artifacts/types.ts";
import { buildZip } from "./export/bundle.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const COMPLETE_DATA: RunBundleData = {
  runId: "11111111-1111-1111-1111-111111111111",
  siteId: "22222222-2222-2222-2222-222222222222",
  domain: "shop.example.com",
  status: "complete",
  overallScore: 84.46,
  createdAt: "2026-07-06T12:00:00.000Z",
  pillars: [{ pillar: "ucp", score: 84.46, signals_passed: 15, signals_total: 20 }],
  signals: [
    { signal_key: "ucp_manifest_present", pillar: "ucp", category: "discovery_manifest", status: "pass", weight: 3, priority_score: 7.5, fix_summary: null, basis: null, merchant_note: null },
    { signal_key: "capability_cart_declared", pillar: "ucp", category: "capabilities", status: "fail", weight: 2, priority_score: 2.67, fix_summary: "Declare dev.ucp.shopping.cart in ucp.capabilities to support multi-item carts.", basis: null, merchant_note: null },
    { signal_key: "ucp_namespace_authority_valid", pillar: "ucp", category: "discovery_manifest", status: "partial", weight: 1, priority_score: 9.0, fix_summary: "Some spec/schema URLs are not on the canonical UCP authority.", basis: null, merchant_note: null },
  ],
  artifacts: [
    {
      artifact_type: "ucp_manifest",
      target_url: "/.well-known/ucp",
      content: JSON.stringify({ ucp: { version: "2026-04-08" } }, null, 2),
      changelog: {
        added: ["ucp.version = \"2026-04-08\""],
        corrected: [],
        must_complete: ["Replace the placeholder shopping service endpoint with your real UCP endpoint URL."],
        flagged: ["Add dev.ucp.common.identity_linking only if you support account-linked experiences — not added automatically."],
      },
      resolves_signal_ids: ["abc-123"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Purity / determinism
// ---------------------------------------------------------------------------

{
  const planA = buildBundlePlan(COMPLETE_DATA);
  check("purity: buildBundlePlan is synchronous, not a Promise", !(planA instanceof Promise));

  const beforeJson = JSON.stringify(COMPLETE_DATA);
  buildBundlePlan(COMPLETE_DATA);
  check("purity: does not mutate the input RunBundleData", JSON.stringify(COMPLETE_DATA) === beforeJson);

  const planB = buildBundlePlan(COMPLETE_DATA);
  check("purity: identical output on repeated calls", JSON.stringify(planA) === JSON.stringify(planB));
}

// ---------------------------------------------------------------------------
// 2. no_manifest run — never a punitive 0%
// ---------------------------------------------------------------------------

{
  const noManifestData: RunBundleData = { ...COMPLETE_DATA, status: "no_manifest", overallScore: null };
  const plan = buildBundlePlan(noManifestData);
  check("no_manifest: markdown shows the 'hasn't started UCP' framing", plan.report_markdown.includes("hasn't started UCP"), plan.report_markdown);
  check("no_manifest: markdown never shows a bare 0%", !/\b0%/.test(plan.report_markdown), plan.report_markdown);
  check("no_manifest: html shows the no-manifest banner", plan.report_html.includes("No manifest found"), plan.report_html);
  check("no_manifest: html never shows a bare 0%", !/>0<span/.test(plan.report_html), plan.report_html);
}

{
  // Sanity: a genuine 0% on a COMPLETE run (not no_manifest) must still show 0 —
  // the suppression is specific to the no_manifest status, not "score is falsy".
  const zeroScoreData: RunBundleData = { ...COMPLETE_DATA, status: "complete", overallScore: 0 };
  const plan = buildBundlePlan(zeroScoreData);
  check("genuine 0% complete run: score IS shown (not suppressed)", plan.report_markdown.includes("Overall UCP Readiness Score: 0%"), plan.report_markdown);
}

// ---------------------------------------------------------------------------
// 3. Prioritized plan ordering
// ---------------------------------------------------------------------------

{
  const plan = buildBundlePlan(COMPLETE_DATA);
  const namespaceIdx = plan.report_markdown.indexOf("ucp_namespace_authority_valid");
  const cartIdx = plan.report_markdown.indexOf("capability_cart_declared");
  check(
    "prioritized plan: higher priority_score (namespace, 9.0) appears before lower (cart, 2.67)",
    namespaceIdx !== -1 && cartIdx !== -1 && namespaceIdx < cartIdx,
    { namespaceIdx, cartIdx },
  );
}

// ---------------------------------------------------------------------------
// 4. Artifact coverage
// ---------------------------------------------------------------------------

{
  const plan = buildBundlePlan(COMPLETE_DATA);
  check("artifact coverage: artifact appears in report_html (display name)", plan.report_html.includes("UCP Manifest"), plan.report_html);
  check(
    "artifact coverage: artifact's file appears in files[]",
    plan.files.some((f) => f.path === "ucp-manifest.json"),
    plan.files.map((f) => f.path),
  );
  check(
    "artifact coverage: must_complete item surfaces in the report",
    plan.report_html.includes("Replace the placeholder shopping service endpoint") && plan.report_markdown.includes("Replace the placeholder shopping service endpoint"),
  );
  check(
    "artifact coverage: flagged item surfaces in the report",
    plan.report_html.includes("Add dev.ucp.common.identity_linking") && plan.report_markdown.includes("Add dev.ucp.common.identity_linking"),
  );
}

// ---------------------------------------------------------------------------
// 5. Future-proofing: an unknown artifact_type is included without error
// ---------------------------------------------------------------------------

{
  const withFutureType: RunBundleData = {
    ...COMPLETE_DATA,
    artifacts: [
      ...COMPLETE_DATA.artifacts,
      {
        artifact_type: "storefront_theme_patch",
        target_url: "theme/patch.json",
        content: JSON.stringify({ theme: { version: "1" } }),
        changelog: { added: ["theme patch"], corrected: [], must_complete: [], flagged: [] },
        resolves_signal_ids: [],
      },
    ],
  };

  check("future-proofing: typeDisplayName never throws on an unknown type", typeof typeDisplayName("storefront_theme_patch") === "string");
  check(
    "future-proofing: unknown type gets a readable auto-generated name",
    typeDisplayName("storefront_theme_patch") === "Storefront Theme Patch",
    typeDisplayName("storefront_theme_patch"),
  );

  let plan: ReturnType<typeof buildBundlePlan> | null = null;
  let threw: unknown = null;
  try {
    plan = buildBundlePlan(withFutureType);
  } catch (e) {
    threw = e;
  }
  check("future-proofing: buildBundlePlan does not throw on an unknown artifact_type", threw === null, threw);
  check("future-proofing: unknown-type artifact appears in report_html", !!plan && plan.report_html.includes("Storefront Theme Patch"), plan?.report_html);
  check(
    "future-proofing: unknown-type artifact's file appears in files[] (no-leading-slash convention preserved)",
    !!plan && plan.files.some((f) => f.path === "theme/patch.json"),
    plan?.files.map((f) => f.path),
  );
}

// ---------------------------------------------------------------------------
// 6. Placeholder contract
// ---------------------------------------------------------------------------

{
  const plan = buildBundlePlan(COMPLETE_DATA);
  const tokenOccurrences = plan.report_html.split(BUNDLE_DOWNLOAD_URL_TOKEN).length - 1;
  check("placeholder: report_html contains exactly one BUNDLE_DOWNLOAD_URL_TOKEN", tokenOccurrences === 1, { tokenOccurrences });

  const offlineReportFile = plan.files.find((f) => f.path === "report.html");
  check("placeholder: the in-zip report.html copy has ZERO occurrences of the token (offline variant)", !!offlineReportFile && !offlineReportFile.contents.includes(BUNDLE_DOWNLOAD_URL_TOKEN), offlineReportFile);
  check(
    "placeholder: the in-zip report.html copy shows an offline note instead",
    !!offlineReportFile && offlineReportFile.contents.toLowerCase().includes("offline"),
    offlineReportFile,
  );
}

// ---------------------------------------------------------------------------
// 7. Bundle file list
// ---------------------------------------------------------------------------

{
  const plan = buildBundlePlan(COMPLETE_DATA);
  const paths = plan.files.map((f) => f.path);
  check("bundle: report.md present", paths.includes("report.md"), paths);
  check("bundle: report.html present", paths.includes("report.html"), paths);
  check("bundle: README.txt present", paths.includes("README.txt"), paths);
  check("bundle: ucp-manifest.json present for the ucp_manifest artifact", paths.includes("ucp-manifest.json"), paths);
  check("bundle: exactly 4 files for one artifact + the 3 report files", paths.length === 4, paths);
}

// ---------------------------------------------------------------------------
// 8. ZIP round-trip (independent minimal reader, verifies the hand-rolled format)
// ---------------------------------------------------------------------------

function readZipEntries(buf: Buffer): Array<{ path: string; contents: string }> {
  const entries: Array<{ path: string; contents: string }> = [];
  let offset = 0;
  while (offset < buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // reached the central directory
    const compression = buf.readUInt16LE(offset + 8);
    if (compression !== 0) throw new Error(`unexpected compression method ${compression} (reader only supports STORED)`);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const path = buf.toString("utf8", nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const contents = buf.toString("utf8", dataStart, dataStart + compSize);
    entries.push({ path, contents });
    offset = dataStart + compSize;
  }
  return entries;
}

{
  const plan = buildBundlePlan(COMPLETE_DATA);
  const zip = buildZip(plan.files);

  check("zip: starts with the local-file-header signature (PK\\x03\\x04)", zip.readUInt32LE(0) === 0x04034b50);
  check("zip: contains the end-of-central-directory signature", zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));

  const roundTripped = readZipEntries(zip);
  check("zip round-trip: same number of entries", roundTripped.length === plan.files.length, { got: roundTripped.length, want: plan.files.length });
  for (const original of plan.files) {
    const found = roundTripped.find((e) => e.path === original.path);
    check(`zip round-trip: "${original.path}" content matches exactly`, !!found && found.contents === original.contents);
  }
}

{
  // A file with non-ASCII content and an empty file — edge cases for the writer.
  const files = [
    { path: "unicode.txt", contents: "café — 日本語 — ✅" },
    { path: "empty.txt", contents: "" },
  ];
  const zip = buildZip(files);
  const roundTripped = readZipEntries(zip);
  check("zip round-trip: unicode content preserved", roundTripped.find((e) => e.path === "unicode.txt")?.contents === files[0].contents);
  check("zip round-trip: empty file preserved", roundTripped.find((e) => e.path === "empty.txt")?.contents === "");
}

// ---------------------------------------------------------------------------
// 9. Multi-file artifact expansion (mcp_scaffold's real shape): a file-tree
//    artifact expands into a subfolder in files[], not a single opaque file.
// ---------------------------------------------------------------------------

{
  const scaffoldFiles = [
    { path: "README.md", contents: "# WooCommerce MCP Shopping Server\n" },
    { path: "package.json", contents: "{}\n" },
    { path: "src/server.ts", contents: "// server\n" },
    { path: "src/woocommerce.ts", contents: "// client\n" },
  ];
  const withScaffold: RunBundleData = {
    ...COMPLETE_DATA,
    artifacts: [
      ...COMPLETE_DATA.artifacts,
      {
        artifact_type: "mcp_scaffold",
        target_url: "mcp-server",
        content: encodeFileTree(scaffoldFiles),
        changelog: { added: ["scaffold"], corrected: [], must_complete: ["Deploy it"], flagged: ["No payment handling"] },
        resolves_signal_ids: [],
      },
    ],
  };

  const plan = buildBundlePlan(withScaffold);
  const paths = plan.files.map((f) => f.path);

  check(
    "mcp_scaffold bundle: every scaffold file appears under the mcp-server/ subfolder",
    scaffoldFiles.every((f) => paths.includes(`mcp-server/${f.path}`)),
    paths,
  );
  check(
    "mcp_scaffold bundle: NOT written as a single opaque file",
    !paths.includes("mcp-server") && !paths.some((p) => p === "mcp_scaffold.txt"),
    paths,
  );
  check(
    "mcp_scaffold bundle: file contents preserved exactly",
    scaffoldFiles.every((f) => plan.files.find((pf) => pf.path === `mcp-server/${f.path}`)?.contents === f.contents),
    null,
  );
  check("mcp_scaffold bundle: report shows the display name", plan.report_html.includes("WooCommerce MCP Shopping Server"), null);
  check(
    "mcp_scaffold bundle: report lists the individual files in the folder",
    plan.report_markdown.includes("mcp-server/README.md") && plan.report_markdown.includes("mcp-server/src/server.ts"),
    plan.report_markdown,
  );

  const zip = buildZip(plan.files);
  const roundTripped = readZipEntries(zip);
  check(
    "mcp_scaffold bundle: the full subtree round-trips through the real ZIP writer",
    scaffoldFiles.every((f) => roundTripped.some((e) => e.path === `mcp-server/${f.path}` && e.contents === f.contents)),
    roundTripped.map((e) => e.path),
  );
}

console.log(failures === 0 ? "\nAll export tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
