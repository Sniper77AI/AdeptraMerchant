-- =============================================================================
-- signal_evidence row for payment_instruments_declared (v2026-04-08 spec-delta
-- audit, 2026-07-14). basis = 'specified': available_instruments = [{type,
-- constraints}] is a literal, checkable field the spec defines on
-- payment_handlers entries. Same idempotent seed pattern as the two prior
-- signal_evidence migrations.
-- =============================================================================

INSERT INTO public.signal_evidence (signal_key, basis, evidence_source, merchant_note, last_reviewed) VALUES

('payment_instruments_declared', 'specified',
 'UCP spec v2026-04-08 (ucp.dev/2026-04-08) — payment_handlers[*][].available_instruments is an array of {type, constraints} objects describing which payment instrument types a handler accepts.',
 'Listing available_instruments tells an AI shopping agent exactly which payment methods a handler accepts (e.g. card, wallet) without it having to guess or fail at checkout. A nice-to-have declaration detail, not required to be UCP-compliant.',
 '2026-07-14')

ON CONFLICT (signal_key) DO NOTHING;
