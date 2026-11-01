-- The chat model is a free-text setting (Settings > Services, `chatModel` /
-- `model`, apps/auth-web/src/lib/ai/openai.ts resolveChatModel), so accounts
-- meter turns on models nobody seeded. The nightly integrity check
-- (prices_from_table) flagged two on 2026-11-01, both metered at
-- unknownModelPrice. USD per 1M tokens as of 2026-11-01
-- (ledger/src/pricing.ts carries the same numbers as the fallback):
--   gpt-4.1-mini  0.40 input / 0.10 cached / 1.60 output
--   gpt-image-2   5 text input / 1.25 cached / 30 output (the image-output
--                 rate: its output tokens are image tokens)
-- effective_from is the epoch, like the opening prices in 0043: a turn
-- metered before this row lands still finds it.
INSERT INTO "ai_model_prices"
  ("model", "input_micros_per_mtok", "cached_input_micros_per_mtok", "output_micros_per_mtok", "effective_from", "note")
VALUES
  ('gpt-4.1-mini',  400000,  100000,  1600000, '1970-01-01T00:00:00Z', 'chosen as a chat model in account settings'),
  ('gpt-image-2',  5000000, 1250000, 30000000, '1970-01-01T00:00:00Z', 'chosen as a chat model in account settings; output at the image rate')
ON CONFLICT DO NOTHING;
