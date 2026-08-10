-- Retained metrics samples (scope telemetry:metrics) — the history behind the
-- SPA's Metrics panel (/metrics + /metrics/recent), while frames.last_metrics
-- keeps only the newest sample. Same shape and retention doctrine as
-- frame_logs: size_bytes precomputed, per-frame cap pruned on insert.
CREATE TABLE "frame_metrics" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"frame_id" uuid NOT NULL REFERENCES "frames"("id") ON DELETE cascade,
	"timestamp" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX frame_metrics_frame_idx ON frame_metrics (frame_id, id);
