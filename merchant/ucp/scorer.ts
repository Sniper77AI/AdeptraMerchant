/**
 * Adeptra Merchant — Scorer (pure).
 *
 * Rolls a run's SignalRow[] into per-pillar summaries matching the
 * `pillar_scores` table, plus an overall run score for `analysis_runs.overall_score`.
 *
 * Rules (from the signal spec):
 *  - Score = earned / achievable * 100, where achievable EXCLUDES not_applicable
 *    signals (they drop out of the denominator, never penalize).
 *  - `signals_total` likewise counts only applicable signals, so
 *    signals_passed/signals_total reads honestly in the UI.
 *  - priority_score (per signal, stamped at insert) = impact * weight / max(effort, 1)
 *    — identical to the formula the mock harness prints.
 *
 * PURE: no I/O, no imports beyond types. Runs anywhere.
 */

import type { SignalRow } from "./manifestChecks.ts";

export interface PillarScoreRow {
  pillar: string;
  score: number; // 0–100, 2dp
  signals_passed: number;
  signals_total: number; // applicable signals only (N/A excluded)
}

export function priorityScore(s: Pick<SignalRow, "impact" | "weight" | "effort">): number {
  return round2((s.impact * s.weight) / Math.max(s.effort, 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Roll signals into one PillarScoreRow per pillar present. */
export function scorePillars(signals: SignalRow[]): PillarScoreRow[] {
  const byPillar = new Map<string, SignalRow[]>();
  for (const s of signals) {
    const arr = byPillar.get(s.pillar) ?? [];
    arr.push(s);
    byPillar.set(s.pillar, arr);
  }

  const rows: PillarScoreRow[] = [];
  for (const [pillar, rowsForPillar] of byPillar) {
    const applicable = rowsForPillar.filter((r) => r.status !== "not_applicable");
    const earned = applicable.reduce((sum, r) => sum + r.score_contribution, 0);
    const achievable = applicable.reduce((sum, r) => sum + r.weight, 0);
    rows.push({
      pillar,
      score: achievable > 0 ? round2((earned / achievable) * 100) : 0,
      signals_passed: applicable.filter((r) => r.status === "pass").length,
      signals_total: applicable.length,
    });
  }
  return rows;
}

/** Overall run score: mean of pillar scores present. With only the UCP pillar
 *  live at MVP this equals the UCP score; once aeo_geo / agent_readability land,
 *  swap in per-pillar weights here (one place, derived data only). */
export function overallScore(pillars: PillarScoreRow[]): number | null {
  if (pillars.length === 0) return null;
  return round2(pillars.reduce((s, p) => s + p.score, 0) / pillars.length);
}
