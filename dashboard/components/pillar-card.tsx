import { Badge } from "@/components/ui/badge";
import type { PillarSection } from "../../merchant/ucp/export/reportModel.ts";
import type { PillarScoreRow } from "../../merchant/ucp/scorer.ts";

/** Renders one pillar exactly as the shared ReportModel describes it — score/
 *  checks-passed/claim from `pillar`, passing/toFix lists from `section`. No
 *  value here is re-derived; it's all read straight off the shared model. */
export function PillarCard({ pillar, section, hasManifest }: { pillar: PillarScoreRow; section: PillarSection; hasManifest: boolean }) {
  const suppressScore = pillar.pillar === "ucp" && !hasManifest;

  return (
    <div className="rounded-lg border p-5 flex-1 min-w-[260px]">
      <div className="font-semibold text-sm">{section.displayName}</div>
      {suppressScore ? (
        <div className="mt-2 rounded-md bg-orange-100 dark:bg-orange-950 text-orange-800 dark:text-orange-300 px-3 py-2 text-sm font-medium">
          This store hasn&apos;t started UCP
        </div>
      ) : (
        <>
          <div className="mt-1 text-4xl font-bold">
            {pillar.score}
            <span className="text-xl font-medium">%</span>
          </div>
          <div className="text-sm text-muted-foreground">
            {pillar.signals_passed}/{pillar.signals_total} checks passed
          </div>
        </>
      )}
      <p className="text-sm text-muted-foreground mt-2">{section.description}</p>

      <div className="mt-4">
        <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">What&apos;s working</div>
        {section.passing.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nothing passing yet — see the fixes below.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {section.passing.map((s) => (
              <li key={s.signal_key}>{s.signal_key}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4">
        <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">What to fix (priority order)</div>
        {section.toFix.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Nothing outstanding — every applicable check passes.</p>
        ) : (
          <ol className="text-sm space-y-3">
            {section.toFix.map((s, i) => (
              <li key={s.signal_key}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-muted-foreground">{i + 1}.</span>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{s.signal_key}</span>
                  <Badge variant={s.status === "fail" ? "destructive" : "secondary"}>{s.status}</Badge>
                </div>
                <p className="mt-1">{s.fix_summary ?? "See evidence for details."}</p>
                {s.merchant_note && (
                  <p className="text-xs text-muted-foreground bg-muted rounded px-2 py-1 mt-1">
                    <strong>Evidence ({s.basis ?? "unspecified"}):</strong> {s.merchant_note}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {section.advisories.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Worth knowing</div>
          <ul className="text-sm space-y-2">
            {section.advisories.map((s) => (
              <li key={s.signal_key}>
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{s.signal_key}</span>
                <p className="text-xs text-muted-foreground mt-1">
                  <strong>({s.basis ?? "unspecified"}):</strong> {s.merchant_note}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
