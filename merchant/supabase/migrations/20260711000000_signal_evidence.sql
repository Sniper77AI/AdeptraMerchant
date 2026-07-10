-- =============================================================================
-- signal_evidence: evidence as DATA, not code. This space (AI crawler behavior,
-- llms.txt adoption, structured-data conventions) moves fast — when Google
-- announces llms.txt support, or a vendor's crawler docs change, we update a
-- row here, not a deploy.
--
-- basis definitions:
--   specified   — a published standard defines it (schema.org vocabulary,
--                  robots exclusion protocol RFC 9309, sitemaps.org protocol)
--   measured    — an independent empirical observation, not vendor self-
--                  disclosure (e.g. Vercel/MERJ's network-level analysis of
--                  569M+ real GPTBot fetches finding no JavaScript execution).
--                  For BEHAVIORAL claims, measured is STRONGER evidence than
--                  documented: vendor docs can be stale or aspirational,
--                  whereas an observation is what actually happened.
--   documented  — a vendor documents the behavior/purpose itself (OpenAI's/
--                  Anthropic's/Perplexity's own crawler docs stating what a
--                  bot is for and whether it honors robots.txt)
--   contested   — an adopted convention where authorities disagree or decline
--                  to confirm effect (llms.txt: read by some agentic/coding
--                  tools, explicitly NOT used by Google Search, no established
--                  correlation with AI citation visibility)
--   no_evidence — a claim with no authoritative backing at all
--
-- WEIGHT vs BASIS: weight/impact encode how much a signal matters IF the
-- underlying claim holds. basis encodes how confident anyone can be that the
-- claim holds. They are never conflated — a low-weight signal is not a way of
-- hiding uncertainty, and a low-basis signal is not automatically low-weight.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_evidence (
  signal_key      TEXT PRIMARY KEY,
  basis           TEXT NOT NULL CHECK (basis IN
                    ('specified', 'measured', 'documented', 'contested', 'no_evidence')),
  evidence_source TEXT,              -- the citation, human-readable
  merchant_note   TEXT,              -- the honest one-liner the merchant reads
  last_reviewed   DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.signal_evidence IS
  'Evidence as data, not code. basis: specified (a published standard defines '
  'it) | measured (independent empirical observation, not vendor self-'
  'disclosure — stronger than documented for behavioral claims) | documented '
  '(a vendor documents the behavior/purpose) | contested (adopted convention, '
  'authorities disagree or decline to confirm effect) | no_evidence (a claim '
  'with no authoritative backing). Read/updated independently of code — when '
  'the evidentiary landscape changes (e.g. Google adopts llms.txt), this table '
  'changes, not a deploy.';

CREATE TRIGGER trg_signal_evidence_updated
  BEFORE UPDATE ON public.signal_evidence
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.signal_evidence ENABLE ROW LEVEL SECURITY;

-- Non-sensitive reference data — any authenticated user can read it. Writes
-- go through the service role only (no INSERT/UPDATE/DELETE policy here),
-- same discipline as analysis_runs/signals immutability from the client side.
CREATE POLICY signal_evidence_select ON public.signal_evidence
  FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- Seed data — the ten agent_readability signals.
-- -----------------------------------------------------------------------------

INSERT INTO public.signal_evidence (signal_key, basis, evidence_source, merchant_note, last_reviewed) VALUES

('robots_txt_valid', 'specified',
 'Robots Exclusion Protocol, RFC 9309 (formalized 2022).',
 'robots.txt is the standard, universally-respected mechanism for telling any crawler what it may access. A missing or unparseable file is a basic access gap, not a judgment call.',
 '2026-07-11'),

('ai_crawler_access_retrieval', 'documented',
 'OpenAI (developers.openai.com/api/docs/bots — OAI-SearchBot), Anthropic (support.claude.com — Claude-SearchBot), Perplexity (docs.perplexity.ai/docs/resources/perplexity-crawlers — PerplexityBot) each document these bots'' purpose as retrieval for AI answer citations, and document that they honor robots.txt.',
 'These bots fetch pages specifically to cite them in AI-generated answers — blocking them removes citation eligibility. One caveat: documented compliance is not always observed compliance. Perplexity''s own docs state that a separate fetcher, Perplexity-User, "generally ignores robots.txt rules... since a user requested the fetch" — and Cloudflare separately documented Perplexity using undeclared, stealth crawlers (rotating IPs, a Chrome-impersonating user agent) to evade robots.txt blocks after PerplexityBot was disallowed (blog.cloudflare.com, Aug 2025). A correctly-configured robots.txt is still worth having; it is not a guarantee against every AI fetcher.',
 '2026-07-11'),

('ai_crawler_access_training', 'documented',
 'OpenAI (developers.openai.com/api/docs/bots — GPTBot) and Anthropic (support.claude.com — ClaudeBot) each document these bots as used to gather training data for their models.',
 'Blocking GPTBot/ClaudeBot to keep your content out of AI model training is a legitimate business decision, not a failure — it has no bearing on whether your store is otherwise agent-readable. If that''s a deliberate choice, attest to it so this signal reflects that instead of failing.',
 '2026-07-11'),

('content_server_rendered', 'measured',
 'Vercel + MERJ network-level analysis of 569M+ real GPTBot fetches (vercel.com/blog/the-rise-of-the-ai-crawler, 2026): "The results consistently show that none of the major AI crawlers currently render JavaScript." GPTBot downloads JS files but does not execute them ~11.5% of the time it encounters one. Gemini and AppleBot are the documented exceptions (both inherit a browser-based, JS-rendering crawler).',
 'If your product content is injected by client-side JavaScript, it is invisible to ChatGPT, Claude, and Perplexity''s crawlers — even while ranking normally on Google or Gemini, which do render JavaScript. This is an architectural property of your site, not something Adeptra can patch for you.',
 '2026-07-11'),

('schema_in_raw_html', 'measured',
 'Same Vercel/MERJ network measurement as content_server_rendered: since no major AI crawler (other than Gemini/AppleBot) executes JavaScript, structured data injected after page load is never seen by them, indistinguishable at fetch time from having no structured data at all.',
 'Structured data (JSON-LD) that your own site injects via JavaScript after the page loads does not exist as far as ChatGPT, Claude, or Perplexity''s crawlers are concerned.',
 '2026-07-11'),

('product_schema_present', 'specified',
 'schema.org Product vocabulary (schema.org/Product).',
 null,
 '2026-07-11'),

('offer_schema_complete', 'specified',
 'schema.org Offer vocabulary (schema.org/Offer) — price, priceCurrency, and availability are the properties an agent needs to reason about purchasability.',
 null,
 '2026-07-11'),

('organization_schema_present', 'specified',
 'schema.org Organization / LocalBusiness vocabulary.',
 null,
 '2026-07-11'),

('sitemap_present', 'specified',
 'Sitemaps protocol (sitemaps.org), referenced from robots.txt per RFC 9309.',
 null,
 '2026-07-11'),

('llms_txt_present', 'contested',
 'Google states plainly it does not use these files: "Google Search itself doesn''t use them... Google Search ignores them" (developers.google.com/search/docs/fundamentals/ai-optimization-guide). Independent studies found no measurable effect: Ahrefs analyzed ~137K domains and found 97% of published llms.txt files were never fetched by anyone in a month (ahrefs.com/blog/llmstxt-study); SE Ranking analyzed ~300K domains and found no significant correlation between llms.txt presence and AI citation frequency (via Search Engine Journal, searchenginejournal.com).',
 'llms.txt is read by some agentic/coding tools, but there is no credible evidence it affects AI search citations or visibility — Google explicitly does not use it, and independent studies of hundreds of thousands of domains found no citation benefit. We check it as agent-readiness infrastructure, not as a visibility lever.',
 '2026-07-11')

ON CONFLICT (signal_key) DO NOTHING;
