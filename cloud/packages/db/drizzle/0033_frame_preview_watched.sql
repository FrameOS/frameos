-- Viewer presence for frame previews.
--
-- The device now tells the hub when it has written a fresh per-scene snapshot
-- ("render" message). Fetching every one of them would mean scraping every
-- frame in every account continuously for images nobody is looking at, which
-- is exactly the cost the fleet-preview doctrine refuses to pay. So the fetch
-- is conditional on someone having the frame open, and this column is what
-- "open" means: any surface that renders a frame's images stamps it, and the
-- hub only acts on a render announcement while the stamp is recent
-- (previewWatchWindowMs in lib/frames.ts).
--
-- Deliberately one timestamp and not a session table: the question is "is
-- anyone watching, roughly now", the write is throttled to one per frame per
-- 30s, and losing it costs a preview that refreshes on the next page load
-- rather than instantly.

ALTER TABLE "frames"
  ADD COLUMN "preview_watched_at" timestamptz;
