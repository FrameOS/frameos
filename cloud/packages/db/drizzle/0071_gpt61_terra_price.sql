-- The AI chat's default moves from gpt-5.6-terra to gpt-6.1-terra
-- (apps/auth-web/src/lib/ai/openai.ts). Its price, USD per 1M tokens as of
-- 2026-10-29: 1 input / 0.05 cached / 5 output (ledger/src/pricing.ts
-- carries the same numbers as the fallback). Without this row a turn meters
-- at unknownModelPrice, 5-6x too high. effective_from is the epoch, like the
-- opening prices in 0043: a turn metered before this row lands still finds it.
INSERT INTO "ai_model_prices"
  ("model", "input_micros_per_mtok", "cached_input_micros_per_mtok", "output_micros_per_mtok", "effective_from", "note")
VALUES
  ('gpt-6.1-terra', 1000000, 50000, 5000000, '1970-01-01T00:00:00Z', 'AI chat default')
ON CONFLICT DO NOTHING;
