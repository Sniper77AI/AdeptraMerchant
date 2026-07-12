import type { ReportModel } from "../../merchant/ucp/export/reportModel.ts";

function ChangelogGroup({ label, items, tone }: { label: string; items: string[]; tone?: "warn" | "flag" }) {
  if (items.length === 0) return null;
  return (
    <div className="text-sm mt-1">
      <strong className={tone === "warn" ? "text-amber-700 dark:text-amber-400" : tone === "flag" ? "text-red-700 dark:text-red-400" : undefined}>{label}:</strong>
      <ul className="list-disc pl-5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** "Your generated fixes" — same artifacts + changelogs as the downloadable
 *  report, minus the actual download (gated separately, see the fix-bundle
 *  section in the store page). */
export function ArtifactList({ artifacts }: { artifacts: ReportModel["artifacts"] }) {
  if (artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground italic">No fix files were generated for this run.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {artifacts.map((a) => (
        <div key={a.artifactType} className="rounded-lg border p-4">
          <div className="font-semibold text-sm">
            {a.displayName} <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{a.filename}</code>
          </div>
          {a.fileList && (
            <ul className="text-xs text-muted-foreground mt-1 list-disc pl-5">
              {a.fileList.map((f) => (
                <li key={f}>
                  <code>
                    {a.filename}
                    {f}
                  </code>
                </li>
              ))}
            </ul>
          )}
          {a.changelog && (
            <>
              <ChangelogGroup label="Added" items={a.changelog.added} />
              <ChangelogGroup label="Corrected" items={a.changelog.corrected} />
              <ChangelogGroup label="You must complete" items={a.changelog.must_complete} tone="warn" />
              <ChangelogGroup label="Flagged (not auto-fixed)" items={a.changelog.flagged} tone="flag" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
