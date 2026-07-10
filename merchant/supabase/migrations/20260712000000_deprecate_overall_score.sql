-- =============================================================================
-- Deprecate analysis_runs.overall_score. COMMENT ONLY — no ALTER, no data
-- touched, no backfill, no recompute. analysis_runs are immutable; that
-- principle applies to our own scoring changes too. The 28 historical values
-- that existed before this migration stay exactly as they are — correct for
-- the world that produced them.
--
-- WHY: this column held a composite score (mean of pillar_scores.score
-- across all pillars for a run). Live data proved that number actively
-- misleads. Two runs of skims.com's real site a day apart:
--   2026-07-09: pillars = {ucp: 86.36}                            -> 86.36
--   2026-07-10: pillars = {ucp: 81.41, agent_readability: 97.14}  -> 89.28
-- UCP compliance genuinely fell (86.36 -> 81.41 — verified by diffing every
-- signal between the two runs; the cause was a newly-configured product
-- feed making seven previously not_applicable Category-2 signals scoreable,
-- five of which passed and two of which failed, not any capability
-- regression) while the averaged composite rose, purely because a second,
-- unrelated pillar got averaged in. There is no principled basis for
-- weighting ucp against agent_readability — they measure non-commensurable
-- things (whether an agent can transact with a store vs. whether an agent
-- can read it at all) — and inventing a weighting would violate the same
-- "no credible basis, no claim" discipline that keeps the aeo_geo pillar
-- empty. pillar_scores is the source of truth; report every pillar
-- explicitly, never averaged.
--
-- No code writes to this column as of this migration (see supabaseSink.ts's
-- completeRun) — it stays at its column default (NULL, no DEFAULT clause)
-- for every run going forward, complete or not. `status` is and remains the
-- ONLY authoritative indicator of run outcome; NULL here no longer
-- distinguishes anything for rows created after this migration.
-- =============================================================================

COMMENT ON COLUMN public.analysis_runs.overall_score IS
  'DEPRECATED as of 2026-07-12. No longer computed or written for new runs — '
  'averaging non-commensurable pillar scores (ucp, agent_readability) '
  'produced a number with no defensible referent; see pillar_scores for the '
  'real, current data. Historical values from before this date reflect a '
  'composite that existed at the time and are left untouched (analysis_runs '
  'are immutable) — do not compare them against rows created after this '
  'migration, which will be NULL regardless of run outcome. Use `status` '
  '(queued/running/complete/no_manifest/failed) for run outcome, never this '
  'column, for any row of any age.';
