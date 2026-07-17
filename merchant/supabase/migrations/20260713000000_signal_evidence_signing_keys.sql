-- =============================================================================
-- signal_evidence row for ucp_signing_keys_present (v2026-04-08 spec-delta
-- patch, 2026-07-13). basis = 'specified': the document-root location is a
-- literal, checkable requirement in the published UCP spec, not an inference
-- or a measurement — same category as robots_txt_valid's RFC 9309 citation.
-- Same idempotent seed pattern as 20260711000000_signal_evidence.sql.
-- =============================================================================

INSERT INTO public.signal_evidence (signal_key, basis, evidence_source, merchant_note, last_reviewed) VALUES

('ucp_signing_keys_present', 'specified',
 'UCP spec v2026-04-08 (ucp.dev/2026-04-08) — signing_keys is a document-root field (sibling of `ucp`), an array of JWK objects, OPTIONAL but RECOMMENDED.',
 'Signed requests/responses let an AI shopping agent cryptographically verify a payload genuinely came from your store, not a spoofed source. Recommended for stores that want verifiable agent interactions — not required to be UCP-compliant.',
 '2026-07-13')

ON CONFLICT (signal_key) DO NOTHING;
