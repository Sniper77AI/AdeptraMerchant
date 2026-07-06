alter table public.artifacts
  add column if not exists changelog_json jsonb;

comment on column public.artifacts.changelog_json is
  'Human-readable summary of what the generator did: {added, corrected, must_complete, flagged}. Populated by the artifact generators via supabaseSink.insertArtifacts.';
