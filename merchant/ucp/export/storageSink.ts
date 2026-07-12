/**
 * Adeptra Merchant — Export storage sink (IMPURE): uploads the zip bundle +
 * standalone report page to Supabase Storage, mints signed URLs, and records
 * an `exports` row via supabaseSink.insertExport.
 *
 * Same auth pattern as supabaseSink.ts: plain fetch + service-role key, no
 * supabase-js. This is a SEPARATE file because it talks to the Storage REST
 * API (a different endpoint family entirely) — but it still delegates the
 * actual `exports` table write to supabaseSink.ts, keeping "only
 * supabaseSink.ts touches PostgREST" true for Postgres-side writes.
 */

import type { SupabaseConfig } from "../supabaseSink.ts";
import { insertExport, authHeaders } from "../supabaseSink.ts";
import { buildZip } from "./bundle.ts";
import { BUNDLE_DOWNLOAD_URL_TOKEN, type BundlePlan } from "./reportBuilder.ts";

const BUCKET = "merchant-exports";

/** Signed-link MVP: a long-but-finite expiry, not real per-user access
 *  control — anyone with the URL can access it until it expires. Revisit if
 *  this ever needs to be revocable or tied to an authenticated viewer. */
const SIGNED_URL_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sanitizePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9.-]/g, "_") || "site";
}

function encodeStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Shared by uploadAndRecordExport (write side) and pipeline.ts's
// getReportHtml/getBundleBytes (read side, via downloadObject below) — one
// source of truth for the folder convention so the two sides can't drift.
export function reportPathFor(domain: string, runId: string): string {
  return `${sanitizePathSegment(domain)}/${runId}/report.html`;
}
export function bundlePathFor(domain: string, runId: string): string {
  return `${sanitizePathSegment(domain)}/${runId}/bundle.zip`;
}

async function uploadObject(cfg: SupabaseConfig, path: string, bytes: Buffer, contentType: string, contentDisposition?: string): Promise<void> {
  const doFetch = cfg.fetcher ?? fetch;
  const res = await doFetch(`${cfg.url}/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      ...authHeaders(cfg),
      "content-type": contentType,
      "x-upsert": "true", // re-exporting the same run overwrites rather than 409s
      ...(contentDisposition ? { "content-disposition": contentDisposition } : {}),
    },
    // Buffer IS a Uint8Array at runtime (Node's fetch accepts it directly);
    // this cast is purely for TypeScript's benefit when this file is type-
    // checked from a consumer whose "lib" includes "dom" (e.g. the
    // dashboard's Next.js build) — the DOM BodyInit type doesn't statically
    // know about Node's Buffer, even though it's a valid Uint8Array. Zero
    // runtime behavior change.
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload ${path} → ${res.status}: ${text}`);
  }
}

async function signObject(cfg: SupabaseConfig, path: string): Promise<string> {
  const doFetch = cfg.fetcher ?? fetch;
  const res = await doFetch(`${cfg.url}/storage/v1/object/sign/${BUCKET}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      ...authHeaders(cfg),
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_EXPIRY_SECONDS }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Storage sign ${path} → ${res.status}: ${text}`);
  const data = JSON.parse(text) as { signedURL: string };
  return `${cfg.url}/storage/v1${data.signedURL}`;
}

/** Downloads an object directly via the service-role key — never a signed
 *  URL. Used by pipeline.ts's getReportHtml/getBundleBytes so the HTTP proxy
 *  routes (merchant/api/report, merchant/api/bundle) never hand a raw
 *  Storage URL to the client; our routes are the front door. Returns null on
 *  a 404 (the run was never exported, or a stale/mismatched path). */
export async function downloadObject(cfg: SupabaseConfig, path: string): Promise<Buffer | null> {
  const doFetch = cfg.fetcher ?? fetch;
  const res = await doFetch(`${cfg.url}/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`, {
    method: "GET",
    headers: { ...authHeaders(cfg) },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage download ${path} → ${res.status}: ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export interface ExportResult {
  reportUrl: string;
  bundleUrl: string;
  bundleStoragePath: string;
  reportStoragePath: string;
  exportId: string;
}

/** Uploads the zip + report.html under {domain}/{runId}/, signs both, patches
 *  the standalone report's download link, and records an `exports` row.
 *
 *  Ordering matters: the zip must be uploaded (and signed) BEFORE the
 *  standalone report.html can be finalized, since the report's download
 *  button needs a bundle link — see reportBuilder.ts's header comment on why
 *  the in-zip report.html copy can't have this same link.
 *
 *  bundleLinkForReport overrides what gets embedded in THAT button. Default
 *  (used by exportRun.ts's CLI, where there's no HTTP server necessarily
 *  running) is the freshly-signed Storage URL. merchant/api/analyze.ts passes
 *  its own /api/bundle/<runId> route instead — raw signed Storage URLs
 *  should never reach a browser once that route exists; it's the front door,
 *  entitlement-checked. ExportResult.bundleUrl is still the real signed URL
 *  regardless (still useful for direct CLI/ops use). */
export async function uploadAndRecordExport(
  cfg: SupabaseConfig,
  siteId: string,
  domain: string,
  runId: string,
  plan: BundlePlan,
  artifactCount: number,
  bundleLinkForReport?: string,
): Promise<ExportResult> {
  const bundleStoragePath = bundlePathFor(domain, runId);
  const reportStoragePath = reportPathFor(domain, runId);

  const zipBytes = buildZip(plan.files);
  await uploadObject(cfg, bundleStoragePath, zipBytes, "application/zip");
  const bundleUrl = await signObject(cfg, bundleStoragePath);

  const finalHtml = plan.report_html.split(BUNDLE_DOWNLOAD_URL_TOKEN).join(bundleLinkForReport ?? bundleUrl);
  await uploadObject(cfg, reportStoragePath, Buffer.from(finalHtml, "utf8"), "text/html; charset=utf-8", "inline");
  const reportUrl = await signObject(cfg, reportStoragePath);

  const exported = await insertExport(cfg, siteId, bundleStoragePath, artifactCount);

  return { reportUrl, bundleUrl, bundleStoragePath, reportStoragePath, exportId: exported.id };
}
