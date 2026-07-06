/**
 * Adeptra Merchant — Real HTTP fetcher (the production implementation of `Fetcher`).
 *
 * PORTABILITY CONTRACT:
 *  - Uses only the platform-native `fetch` + `AbortController` (Node 18+/n8n code
 *    node/edge runtime). No npm dependencies.
 *  - Satisfies the exact `Fetcher` type from manifestChecks.ts, so it drops into
 *    `runManifestChecks(domain, httpFetcher)` with zero changes to signal logic.
 *
 * Behavior decisions (mirroring the signal spec):
 *  - Timeout is enforced by the caller-supplied `timeoutMs` (manifestChecks passes
 *    5000ms — the strict backpressure cap). A timeout REJECTS, which fetchManifest
 *    already converts into `fetch_failed: ...` → manifest unreachable.
 *  - Redirects are followed MANUALLY so the full chain is recorded. We follow up to
 *    HARD_REDIRECT_CAP hops so we can still parse the manifest and report the chain
 *    as evidence; the *penalty* for >1 redirect lives in sig_manifest_present, not here.
 *  - `requiresAuth` is true on 401/403 or a WWW-Authenticate header.
 */

import type { Fetcher, FetchResult } from "./manifestChecks.ts";

/** Follow at most this many redirects before giving up. The signal layer already
 *  penalizes anything beyond 1 hop; this cap just prevents redirect loops. */
const HARD_REDIRECT_CAP = 5;

const USER_AGENT = "AdeptraMerchant-UCP-Checker/0.1 (+https://adeptra.ai)";

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export const httpFetcher: Fetcher = async (url: string, timeoutMs: number): Promise<FetchResult> => {
  const redirectChain: string[] = [];
  let currentUrl = url;

  // One shared deadline across all hops — a redirect loop can't extend the budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

  try {
    for (let hop = 0; hop <= HARD_REDIRECT_CAP; hop++) {
      const res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });

      // Redirect: record the hop and follow it ourselves.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          // Redirect status with no Location — treat as terminal response.
          const headers = headersToRecord(res.headers);
          const body = await res.text();
          return {
            status: res.status,
            headers,
            body,
            redirectChain,
            requiresAuth: false,
          };
        }
        const nextUrl = new URL(location, currentUrl).toString();
        redirectChain.push(nextUrl);
        if (hop === HARD_REDIRECT_CAP) {
          throw new Error(`too many redirects (> ${HARD_REDIRECT_CAP})`);
        }
        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => undefined);
        currentUrl = nextUrl;
        continue;
      }

      const headers = headersToRecord(res.headers);
      const body = await res.text();
      const requiresAuth =
        res.status === 401 || res.status === 403 || !!res.headers.get("www-authenticate");

      return {
        status: res.status,
        headers,
        body,
        redirectChain,
        requiresAuth,
      };
    }
    // Unreachable (loop either returns or throws), but keeps TS happy.
    throw new Error("redirect loop");
  } finally {
    clearTimeout(timer);
  }
};
