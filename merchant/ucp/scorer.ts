/**
 * Adeptra Merchant — Scorer (pure).
 *
 * Rolls a run's SignalRow[] into per-pillar summaries matching the
 * `pillar_scores` table. That's it — there is deliberately no composite
 * "overall score" anymore.
 *
 * WHY NO COMPOSITE (removed 2026-07-10, see README): this scorer computes
 * one number per pillar (`ucp`, `agent_readability`) and stops there. An
 * earlier version averaged pillar scores into a single number. Live data
 * proved that number actively misleads: two skims.com runs a day apart went
 * from {ucp: 86.36} -> {ucp: 81.41, agent_readability: 97.14}. UCP
 * compliance REGRESSED (86.36 -> 81.41) while the averaged composite ROSE
 * (86.36 -> 89.28), purely because a second, unrelated pillar got averaged
 * in. A merchant tracking the headline number would see improvement where
 * there was regression. There is no principled basis for weighting UCP
 * against agent_readability — they measure non-commensurable things
 * ("can an agent transact with you" vs. "can an agent read you at all") —
 * and inventing a weighting would violate the same "no credible basis, no
 * claim" discipline that keeps the aeo_geo pillar empty. `pillar_scores` is
 * the source of truth; report both pillars explicitly, never averaged, never
 * presented as substitutes for each other. If a single headline number is
 * ever needed, it must be categorical and derived from signal gates (e.g.
 * "discoverable, not yet buyable"), never an arithmetic mean of these rows.
 *
 * Rules (from the signal spec):
 *  - Score = earned / achievable * 100, where achievable EXCLUDES not_applicable
 *    signals (they drop out of the denominator, never penalize).
 *  - `signals_total` likewise counts only applicable signals, so
 *    signals_passed/signals_total reads honestly in the UI.
 *  - priority_score (per signal, stamped at insert) = impact * weight / max(effort, 1)
 *    — identical to the formula the mock harness prints.
 *  - weight === 0 signals (Category 6 — Merchant Center Eligibility) are also
 *    excluded, the same as not_applicable. Category 6 is explicitly a separate
 *    "readiness checklist," not part of capability-quality scoring — the
 *    weight classes for Categories 1–5 already sum to 1.00 on their own.
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
    const applicable = rowsForPillar.filter((r) => r.status !== "not_applicable" && r.weight > 0);
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
