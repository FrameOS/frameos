-- How the cloud dithers the picture it packs for a frame's palette panel
-- (server rendering, thin clients; docs/dithering.md): NULL keeps
-- Floyd-Steinberg, {"method": "opendisplay", ...} picks OpenDisplay
-- epaper-dithering (auth-web's panel-dither.ts). The backend's twin is
-- the frame table's `dither` column.

ALTER TABLE "frames" ADD COLUMN "dither" jsonb;
