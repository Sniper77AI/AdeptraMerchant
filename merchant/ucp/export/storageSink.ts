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
import { insertExport } from "../supabaseSink.ts";
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

async function uploadObject(cfg: SupabaseConfig, path: string, bytes: Buffer, contentType: string): Promise<void> {
  const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.serviceRoleKey}`,
      apikey: cfg.serviceRoleKey,
      "content-type": contentType,
      "x-upsert": "true", // re-exporting the same run overwrites rather than 409s
    },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload ${path} → ${res.status}: ${text}`);
  }
}

async function signObject(cfg: SupabaseConfig, path: string): Promise<string> {
  const res = await fetch(`${cfg.url}/storage/v1/object/sign/${BUCKET}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.serviceRoleKey}`,
      apikey: cfg.serviceRoleKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_EXPIRY_SECONDS }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Storage sign ${path} → ${res.status}: ${text}`);
  const data = JSON.parse(text) as { signedURL: string };
  return `${cfg.url}/storage/v1${data.signedURL}`;
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
 *  button needs the zip's real signed URL — see reportBuilder.ts's header
 *  comment on why the in-zip report.html copy can't have this same link. */
export async function uploadAndRecordExport(
  cfg: SupabaseConfig,
  siteId: string,
  domain: string,
  runId: string,
  plan: BundlePlan,
  artifactCount: number,
): Promise<ExportResult> {
  const folder = `${sanitizePathSegment(domain)}/${runId}`;
  const bundleStoragePath = `${folder}/bundle.zip`;
  const reportStoragePath = `${folder}/report.html`;

  const zipBytes = buildZip(plan.files);
  await uploadObject(cfg, bundleStoragePath, zipBytes, "application/zip");
  const bundleUrl = await signObject(cfg, bundleStoragePath);

  const finalHtml = plan.report_html.split(BUNDLE_DOWNLOAD_URL_TOKEN).join(bundleUrl);
  await uploadObject(cfg, reportStoragePath, Buffer.from(finalHtml, "utf8"), "text/html; charset=utf-8");
  const reportUrl = await signObject(cfg, reportStoragePath);

  const exported = await insertExport(cfg, siteId, bundleStoragePath, artifactCount);

  return { reportUrl, bundleUrl, bundleStoragePath, reportStoragePath, exportId: exported.id };
}
