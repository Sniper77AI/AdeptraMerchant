/**
 * Adeptra Merchant — Report & bundle-plan builder (PURE: no network, no DB,
 * no secrets). Turns a completed run's data into an in-memory description of
 * everything the merchant-ready export needs: a markdown report, a
 * standalone self-contained HTML report page, and the list of files to zip.
 *
 * FUTURE-PROOFING: iterates over whatever artifacts exist for the run, driven
 * generically by artifact_type. A new generator (e.g. "mcp_scaffold") needs
 * at most one line in ARTIFACT_TYPE_DISPLAY_NAMES to get a friendly name —
 * everything else (inclusion in the report, the zip, filename derivation)
 * already works via the generic fallback.
 *
 * THE DOWNLOAD-LINK CIRCULARITY: the in-zip copy of report.html can't contain
 * a working signed link to the zip it's already inside — that zip doesn't
 * exist (and can't be signed) until AFTER it's uploaded, which happens AFTER
 * this pure step. So renderHtml produces two variants from one template: the
 * standalone copy (returned as `report_html`, uploaded separately) carries
 * the {{BUNDLE_DOWNLOAD_URL}} token for storageSink.ts to substitute; the
 * in-zip copy (in `files`) renders a static "this is your offline snapshot"
 * note in that spot instead of a dead token or a circular self-link.
 */

import type { PillarScoreRow } from "../scorer.ts";
import type { ArtifactChangelog } from "../artifacts/types.ts";
import { decodeFileTree } from "../artifacts/types.ts";
import type { BundleFile } from "./bundle.ts";

export const BUNDLE_DOWNLOAD_URL_TOKEN = "{{BUNDLE_DOWNLOAD_URL}}";

// ---------------------------------------------------------------------------
// Input contract (supabaseSink.fetchRunBundleData conforms to this)
// ---------------------------------------------------------------------------

export interface RunBundleSignal {
  signal_key: string;
  pillar: string;
  category: string;
  status: "pass" | "partial" | "fail" | "not_applicable";
  weight: number;
  priority_score: number;
  fix_summary: string | null;
  // From signal_evidence — joined by signal_key at read time, not snapshotted
  // onto the signals row (basis is a fact about external evidence, which can
  // be revised after the run; looking it up fresh keeps every re-render
  // current without ever mutating a completed run's scored signals).
  basis: string | null;
  merchant_note: string | null;
}

export interface RunBundleArtifact {
  artifact_type: string;
  target_url: string | null;
  content: string | null;
  changelog: ArtifactChangelog | null;
  resolves_signal_ids: string[] | null;
}

export interface RunBundleData {
  runId: string;
  siteId: string; // not used by rendering — carried through for storageSink's exports-row insert
  domain: string;
  status: string; // 'complete' | 'no_manifest' | 'failed' | ...
  createdAt: string;
  pillars: PillarScoreRow[];
  signals: RunBundleSignal[];
  artifacts: RunBundleArtifact[];
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface BundlePlan {
  report_markdown: string;
  report_html: string; // standalone copy — contains BUNDLE_DOWNLOAD_URL_TOKEN once
  files: BundleFile[]; // everything that goes in the zip (includes an offline report.html variant)
}

// ---------------------------------------------------------------------------
// artifact_type -> friendly name (add one line per new type; unknown types
// still get a reasonable auto-generated name via the fallback)
// ---------------------------------------------------------------------------

const ARTIFACT_TYPE_DISPLAY_NAMES: Record<string, string> = {
  ucp_manifest: "UCP Manifest",
  feed_fix: "Product Feed Fix (Supplemental Feed)",
  jsonld: "Structured Data (JSON-LD)",
  llms_txt: "llms.txt",
  robots_patch: "robots.txt Patch",
  content_rewrite: "Content Rewrite",
  mcp_scaffold: "WooCommerce MCP Shopping Server",
};

// ---------------------------------------------------------------------------
// pillar -> friendly section name + exact claim sentence. aeo_geo isn't
// listed: it's an intentionally empty pillar (see README) and never appears
// in real signal data, so it never needs a display name here.
//
// NO COMPOSITE: these two pillars measure non-commensurable things — whether
// agents can reach/read/understand a store at all (searchable) vs. whether an
// agent can actually transact with it (buyable). They are always shown side
// by side, each labeled with its own claim, never averaged into one number.
// See scorer.ts's header comment for why.
// ---------------------------------------------------------------------------

const PILLAR_DISPLAY_NAMES: Record<string, string> = {
  ucp: "UCP Protocol Compliance",
  agent_readability: "Agent Readability",
};

const PILLAR_DESCRIPTIONS: Record<string, string> = {
  agent_readability: "Can AI systems reach, read, and correctly understand your store?",
  ucp: "Can an AI shopping agent actually transact with your store?",
};

// agent_readability first: it's the precondition ("searchable") for
// everything ucp ("buyable") measures. Any pillar not listed here (a future
// aeo_geo, once it's ever populated) falls back to first-seen order.
const PILLAR_DISPLAY_ORDER = ["agent_readability", "ucp"];

function canonicalPillarOrder(pillarKeys: string[]): string[] {
  const seen: string[] = [];
  for (const p of pillarKeys) if (!seen.includes(p)) seen.push(p);
  const known = PILLAR_DISPLAY_ORDER.filter((p) => seen.includes(p));
  const rest = seen.filter((p) => !PILLAR_DISPLAY_ORDER.includes(p));
  return [...known, ...rest];
}

export function pillarDisplayName(pillar: string): string {
  return PILLAR_DISPLAY_NAMES[pillar] ?? pillar;
}

export function typeDisplayName(artifactType: string): string {
  if (ARTIFACT_TYPE_DISPLAY_NAMES[artifactType]) return ARTIFACT_TYPE_DISPLAY_NAMES[artifactType];
  return artifactType
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Derives a sensible in-zip filename from an artifact's target_url.
 *  - "/.well-known/ucp" (a served path with no extension) has a dedicated name.
 *  - No leading slash means "upload artifact, already a good relative path"
 *    (see manifestArtifact.ts / feedArtifact.ts's target_url convention) — used as-is.
 *  - Any other served path (leading slash): stripped and flattened.
 *  - No target_url at all: falls back to the artifact type. */
export function filenameForArtifact(artifactType: string, targetUrl: string | null): string {
  if (targetUrl === "/.well-known/ucp") return "ucp-manifest.json";
  if (!targetUrl) return `${artifactType}.txt`;
  if (!targetUrl.startsWith("/")) return targetUrl;
  const stripped = targetUrl.replace(/^\/+/, "");
  return stripped.includes(".") ? stripped.replace(/\//g, "-") : `${stripped.replace(/\//g, "-")}.txt`;
}

// ---------------------------------------------------------------------------
// Report model (shared by markdown + html + README rendering)
// ---------------------------------------------------------------------------

interface ReportArtifact {
  artifactType: string;
  displayName: string;
  filename: string;
  changelog: ArtifactChangelog | null;
  fileList?: string[]; // set only for multi-file (file-tree) artifacts — see decodeFileTree
}

/** One section per pillar present in the run's signals, in first-seen order
 *  (pipeline.ts pushes ucp signals before agent_readability's, so this falls
 *  out naturally — no hardcoded pillar list to keep in sync). */
interface PillarSection {
  pillar: string;
  displayName: string;
  description: string;
  passing: RunBundleSignal[];
  toFix: RunBundleSignal[]; // fail/partial, sorted by priority_score desc
}

interface ReportModel {
  domain: string;
  runId: string;
  createdAt: string;
  hasManifest: boolean; // false => no_manifest — the ucp pillar shows "hasn't started" framing instead of its score; agent_readability is unaffected, it's measurable either way
  pillars: PillarScoreRow[]; // canonical order (agent_readability, ucp), real numbers always — never suppressed
  sections: PillarSection[];
  artifacts: ReportArtifact[];
}

function buildSections(data: RunBundleData): PillarSection[] {
  const pillarKeys = canonicalPillarOrder(data.signals.map((s) => s.pillar));
  return pillarKeys.map((pillar) => {
    const pillarSignals = data.signals.filter((s) => s.pillar === pillar);
    return {
      pillar,
      displayName: pillarDisplayName(pillar),
      description: PILLAR_DESCRIPTIONS[pillar] ?? "",
      passing: pillarSignals.filter((s) => s.status === "pass"),
      toFix: pillarSignals
        .filter((s) => s.status === "fail" || s.status === "partial")
        .slice()
        .sort((a, b) => b.priority_score - a.priority_score),
    };
  });
}

function buildModel(data: RunBundleData): ReportModel {
  const sections = buildSections(data);
  const artifacts = data.artifacts.map((a) => {
    const fileTree = a.content ? decodeFileTree(a.content) : null;
    return {
      artifactType: a.artifact_type,
      displayName: typeDisplayName(a.artifact_type),
      filename: fileTree ? `${a.target_url ?? a.artifact_type}/` : filenameForArtifact(a.artifact_type, a.target_url),
      changelog: a.changelog,
      fileList: fileTree ? fileTree.files.map((f) => f.path) : undefined,
    };
  });

  const pillarKeyOrder = canonicalPillarOrder(data.pillars.map((p) => p.pillar));
  const orderedPillars = pillarKeyOrder.map((k) => data.pillars.find((p) => p.pillar === k)!).filter(Boolean);

  return {
    domain: data.domain,
    runId: data.runId,
    createdAt: data.createdAt,
    hasManifest: data.status !== "no_manifest",
    pillars: orderedPillars,
    sections,
    artifacts,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(model: ReportModel): string {
  const lines: string[] = [];
  lines.push(`# AI Commerce Readiness Report — ${model.domain}`);
  lines.push("");
  lines.push(`Run: \`${model.runId}\`  ·  Generated: ${model.createdAt}`);
  lines.push("");
  lines.push(
    "AI shopping agents (ChatGPT, Gemini, Perplexity, Google AI Mode) can only help customers buy from a store they can find, understand, and transact with. Two independent things determine that: whether agents can reach, read, and understand your store at all (**searchable**), and whether an agent can actually complete a purchase through the Universal Commerce Protocol (**buyable**). This report measures both separately, below — never averaged into one score, because being searchable doesn't imply being buyable, and vice versa.",
  );
  lines.push("");

  lines.push("## Your scores");
  lines.push("");
  if (model.pillars.length === 0) {
    lines.push("No pillar scores recorded for this run.");
  } else {
    for (const p of model.pillars) {
      const displayName = pillarDisplayName(p.pillar);
      const claim = PILLAR_DESCRIPTIONS[p.pillar] ?? "";
      if (p.pillar === "ucp" && !model.hasManifest) {
        lines.push(`**${displayName}** — ${claim}`);
        lines.push("_This store hasn't started UCP yet — no \`/.well-known/ucp\` manifest published. The fixes below include a complete starter manifest to get going._");
      } else {
        lines.push(`**${displayName}: ${p.score}%** (${p.signals_passed}/${p.signals_total} checks passed) — ${claim}`);
      }
      lines.push("");
    }
  }

  for (const section of model.sections) {
    lines.push(`## ${section.displayName}`);
    lines.push("");
    if (section.description) {
      lines.push(section.description);
      lines.push("");
    }

    lines.push("### What's working");
    lines.push("");
    if (section.passing.length === 0) {
      lines.push("Nothing passing yet — see the fixes below.");
    } else {
      for (const s of section.passing) lines.push(`- ${s.signal_key}`);
    }
    lines.push("");

    lines.push("### What to fix (in priority order)");
    lines.push("");
    if (section.toFix.length === 0) {
      lines.push("Nothing outstanding — every applicable check passes.");
    } else {
      section.toFix.forEach((s, i) => {
        lines.push(`${i + 1}. **${s.signal_key}** (${s.status}) — ${s.fix_summary ?? "see evidence for details"}`);
        if (s.merchant_note) lines.push(`   - *Evidence (${s.basis ?? "unspecified"}):* ${s.merchant_note}`);
      });
    }
    lines.push("");
  }

  lines.push("## Your generated fixes");
  lines.push("");
  if (model.artifacts.length === 0) {
    lines.push("No fix files were generated for this run.");
  } else {
    for (const a of model.artifacts) {
      lines.push(`### ${a.displayName} (\`${a.filename}\`)`);
      lines.push("");
      if (a.fileList) {
        lines.push("Files in this folder:");
        for (const f of a.fileList) lines.push(`- \`${a.filename}${f}\``);
        lines.push("");
      }
      const c = a.changelog;
      if (c) {
        if (c.added.length) lines.push(`- Added: ${c.added.join("; ")}`);
        if (c.corrected.length) lines.push(`- Corrected: ${c.corrected.join("; ")}`);
        if (c.must_complete.length) {
          lines.push(`- **You must complete:**`);
          for (const m of c.must_complete) lines.push(`  - ${m}`);
        }
        if (c.flagged.length) {
          lines.push(`- **Flagged (not auto-fixed):**`);
          for (const f of c.flagged) lines.push(`  - ${f}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML rendering (single self-contained file, inline CSS, no external requests)
// ---------------------------------------------------------------------------

function renderHtml(model: ReportModel, downloadUrlToken: string | null): string {
  // Two pillar cards, always shown side by side with equal visual weight —
  // never averaged into one headline number. agent_readability always shows
  // its real score (it's measurable with or without a manifest); ucp shows
  // the honest "hasn't started" framing instead of a number when there's no
  // manifest, same substance as the old global no-manifest banner, now
  // scoped to the pillar it actually describes.
  const pillarScoreCards = model.pillars
    .map((p) => {
      const claim = escapeHtml(PILLAR_DESCRIPTIONS[p.pillar] ?? "");
      const scoreBlock =
        p.pillar === "ucp" && !model.hasManifest
          ? `<div class="status-banner status-no-manifest">This store hasn't started UCP</div>`
          : `<div class="score">${p.score}<span class="score-pct">%</span></div><div class="score-label">${p.signals_passed}/${p.signals_total} checks passed</div>`;
      return `<div class="pillar-score-card">
        <div class="pillar-score-name">${escapeHtml(pillarDisplayName(p.pillar))}</div>
        ${scoreBlock}
        <div class="pillar-score-claim">${claim}</div>
      </div>`;
    })
    .join("\n");

  const downloadSection = downloadUrlToken
    ? `<a class="download-btn" href="${escapeHtml(downloadUrlToken)}">⬇ Download the fix bundle (ZIP)</a>`
    : `<div class="offline-note">This is the offline copy included in your downloaded bundle — no separate download needed.</div>`;

  const sectionBlocks = model.sections
    .map((section) => {
      const passingItems = section.passing.length
        ? section.passing.map((s) => `<li>${escapeHtml(s.signal_key)}</li>`).join("\n")
        : `<li class="muted">Nothing passing yet — see "What to fix" below.</li>`;

      const fixItems = section.toFix.length
        ? section.toFix
            .map((s, i) => {
              const note = s.merchant_note
                ? `<p class="evidence-note"><strong>Evidence (${escapeHtml(s.basis ?? "unspecified")}):</strong> ${escapeHtml(s.merchant_note)}</p>`
                : "";
              return `<li><span class="fix-rank">${i + 1}</span> <span class="fix-key">${escapeHtml(s.signal_key)}</span><span class="fix-status status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span><p>${escapeHtml(s.fix_summary ?? "See evidence for details.")}</p>${note}</li>`;
            })
            .join("\n")
        : `<li class="muted">Nothing outstanding — every applicable check passes.</li>`;

      return `<h2>${escapeHtml(section.displayName)}</h2>
  ${section.description ? `<p class="pillar-description">${escapeHtml(section.description)}</p>` : ""}
  <h3>What's working</h3>
  <ul>${passingItems}</ul>
  <h3>What to fix (in priority order)</h3>
  <ul>${fixItems}</ul>`;
    })
    .join("\n\n");

  const artifactBlocks = model.artifacts.length
    ? model.artifacts
        .map((a) => {
          const c = a.changelog;
          const group = (label: string, items: string[], cls: string) =>
            items.length
              ? `<div class="changelog-group ${cls}"><strong>${label}:</strong><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`
              : "";
          const fileListBlock = a.fileList
            ? `<div class="changelog-group"><strong>Files in this folder:</strong><ul>${a.fileList.map((f) => `<li><code>${escapeHtml(a.filename + f)}</code></li>`).join("")}</ul></div>`
            : "";
          return `<div class="artifact">
        <h3>${escapeHtml(a.displayName)} <code>${escapeHtml(a.filename)}</code></h3>
        ${fileListBlock}
        ${c ? group("Added", c.added, "added") : ""}
        ${c ? group("Corrected", c.corrected, "corrected") : ""}
        ${c ? group("You must complete", c.must_complete, "must-complete") : ""}
        ${c ? group("Flagged (not auto-fixed)", c.flagged, "flagged") : ""}
      </div>`;
        })
        .join("\n")
    : `<p class="muted">No fix files were generated for this run.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Commerce Readiness Report — ${escapeHtml(model.domain)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.5; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111315; } }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; border-bottom: 1px solid #ddd; padding-bottom: 0.4rem; }
  @media (prefers-color-scheme: dark) { h2 { border-bottom-color: #333; } }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .meta code { font-size: 0.85em; }
  .pillar-scores { display: flex; gap: 1.25rem; flex-wrap: wrap; margin: 1.25rem 0; }
  .pillar-score-card { flex: 1 1 240px; background: #f6f7f9; border-radius: 10px; padding: 1.25rem 1.5rem; }
  @media (prefers-color-scheme: dark) { .pillar-score-card { background: #1c1f22; } }
  .pillar-score-name { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.5rem; }
  .pillar-score-claim { color: #666; font-size: 0.88rem; margin-top: 0.5rem; }
  @media (prefers-color-scheme: dark) { .pillar-score-claim { color: #999; } }
  .score { font-size: 2.75rem; font-weight: 700; }
  .score-pct { font-size: 1.5rem; font-weight: 500; }
  .score-label { color: #666; }
  @media (prefers-color-scheme: dark) { .score-label { color: #999; } }
  .status-banner { font-weight: 600; padding: 0.75rem 1rem; border-radius: 8px; background: #fff4e5; color: #7a4b00; }
  .status-no-manifest { background: #fdecea; color: #7a1f1f; }
  .download-btn { display: inline-block; margin: 1rem 0 1.5rem; padding: 0.7rem 1.25rem; background: #1a56db; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
  .offline-note { margin: 1rem 0 1.5rem; padding: 0.7rem 1rem; background: #eef2f7; border-radius: 8px; color: #444; font-size: 0.9rem; }
  @media (prefers-color-scheme: dark) { .offline-note { background: #1c1f22; color: #aaa; } }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; }
  @media (prefers-color-scheme: dark) { th, td { border-bottom-color: #2a2d30; } }
  ul { padding-left: 1.1rem; }
  li.muted, p.muted { color: #888; font-style: italic; }
  .fix-rank { display: inline-block; width: 1.6rem; font-weight: 700; color: #1a56db; }
  .fix-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; background: #f1f3f5; padding: 0.1rem 0.4rem; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { .fix-key { background: #26292c; } }
  .fix-status { font-size: 0.75rem; text-transform: uppercase; margin-left: 0.5rem; padding: 0.05rem 0.4rem; border-radius: 4px; }
  .status-fail { background: #fdecea; color: #7a1f1f; }
  .status-partial { background: #fff4e5; color: #7a4b00; }
  .pillar-description { color: #666; font-size: 0.92rem; margin-top: -0.5rem; }
  @media (prefers-color-scheme: dark) { .pillar-description { color: #999; } }
  .evidence-note { font-size: 0.85rem; color: #555; background: #f6f7f9; border-radius: 6px; padding: 0.4rem 0.6rem; margin-top: 0.4rem; }
  @media (prefers-color-scheme: dark) { .evidence-note { color: #bbb; background: #1c1f22; } }
  .artifact { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  @media (prefers-color-scheme: dark) { .artifact { border-color: #2a2d30; } }
  .artifact h3 { margin-top: 0; font-size: 1rem; }
  .artifact code { font-size: 0.8rem; background: #f1f3f5; padding: 0.1rem 0.4rem; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { .artifact code { background: #26292c; } }
  .changelog-group { margin: 0.5rem 0; font-size: 0.92rem; }
  .changelog-group.must-complete strong { color: #b45309; }
  .changelog-group.flagged strong { color: #7a1f1f; }
  footer { margin-top: 3rem; color: #999; font-size: 0.8rem; }
</style>
</head>
<body>
  <h1>AI Commerce Readiness Report</h1>
  <div class="meta">${escapeHtml(model.domain)} · run <code>${escapeHtml(model.runId)}</code> · generated ${escapeHtml(model.createdAt)}</div>

  <p>AI shopping agents (ChatGPT, Gemini, Perplexity, Google AI Mode) can only help customers buy from a store they can find, understand, and transact with. Two independent things determine that: whether agents can reach, read, and understand your store at all (<strong>searchable</strong>), and whether an agent can actually complete a purchase through the Universal Commerce Protocol (<strong>buyable</strong>). This report measures both separately, below — never averaged into one score, because being searchable doesn't imply being buyable, and vice versa.</p>

  <div class="pillar-scores">${pillarScoreCards || '<p class="muted">No pillar scores recorded.</p>'}</div>
  ${downloadSection}

  ${sectionBlocks}

  <h2>Your generated fixes</h2>
  ${artifactBlocks}

  <footer>Generated by Adeptra Merchant.</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// README.txt (plain text, non-expert-friendly)
// ---------------------------------------------------------------------------

function buildReadme(model: ReportModel): string {
  const lines: string[] = [];
  lines.push("ADEPTRA MERCHANT — AI COMMERCE READINESS FIX BUNDLE");
  lines.push(`Store: ${model.domain}`);
  lines.push(`Run: ${model.runId}`);
  lines.push(`Generated: ${model.createdAt}`);
  lines.push("");
  lines.push("WHAT THIS IS");
  lines.push("This bundle contains the results of an AI commerce readiness analysis of your");
  lines.push("store — whether AI agents can find and understand it (searchable), and whether");
  lines.push("they can transact with it via UCP (buyable) — plus the fix files our system");
  lines.push("generated for you.");
  lines.push("");
  lines.push("FILES IN THIS BUNDLE");
  lines.push("- report.md / report.html  the full readiness report (open report.html in any browser)");
  lines.push("- README.txt               this file");
  for (const a of model.artifacts) {
    const kind = a.fileList ? "folder" : "file";
    lines.push(`- ${a.filename}  ${a.displayName} (${kind}) — see report.html for what changed and what you still owe`);
  }
  lines.push("");
  lines.push("WHAT TO DO, IN ORDER");
  lines.push('1. Open report.html and read "What to fix" — it is ordered by priority.');
  lines.push('2. For each generated fix file, read its "you must complete" notes in the');
  lines.push("   report before using it — some values are placeholders you need to fill in.");
  lines.push("3. Deploy each fix file to the path noted in the report (e.g. the manifest");
  lines.push("   goes at /.well-known/ucp on your domain).");
  lines.push('4. Anything listed as "flagged" was intentionally NOT auto-fixed — those need');
  lines.push("   a human decision.");
  lines.push("");
  lines.push("Questions? Contact whoever sent you this bundle.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildBundlePlan(data: RunBundleData): BundlePlan {
  const model = buildModel(data);

  const reportMarkdown = renderMarkdown(model);
  const reportHtmlStandalone = renderHtml(model, BUNDLE_DOWNLOAD_URL_TOKEN);
  const reportHtmlOffline = renderHtml(model, null);
  const readme = buildReadme(model);

  const files: BundleFile[] = [
    { path: "report.md", contents: reportMarkdown },
    { path: "report.html", contents: reportHtmlOffline },
    { path: "README.txt", contents: readme },
  ];
  for (const a of data.artifacts) {
    if (a.content == null) continue;
    const fileTree = decodeFileTree(a.content);
    if (fileTree) {
      // Multi-file artifact: expand into a subfolder rather than one file.
      // Keyed off the content shape (see artifacts/types.ts), not artifact_type,
      // so any future multi-file generator gets this for free.
      const folder = a.target_url ?? a.artifact_type;
      for (const f of fileTree.files) files.push({ path: `${folder}/${f.path}`, contents: f.contents });
    } else {
      files.push({ path: filenameForArtifact(a.artifact_type, a.target_url), contents: a.content });
    }
  }

  return { report_markdown: reportMarkdown, report_html: reportHtmlStandalone, files };
}
