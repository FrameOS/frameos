-- The store classifier moves from gpt-4o-mini (OpenAI is retiring the gpt-4
-- family) to gpt-6-luna. Its price, USD per 1M tokens as of 2026-10-14:
-- 0.1 input / 0.01 cached / 0.5 output (ledger/src/pricing.ts carries the
-- same numbers as the fallback). effective_from is the epoch, like the
-- opening prices in 0043: a turn metered before this row lands still finds it.
INSERT INTO "ai_model_prices"
  ("model", "input_micros_per_mtok", "cached_input_micros_per_mtok", "output_micros_per_mtok", "effective_from", "note")
VALUES
  ('gpt-6-luna', 100000, 10000, 500000, '1970-01-01T00:00:00Z', 'store classifier / recategorize')
ON CONFLICT DO NOTHING;
