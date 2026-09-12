-- HyperPixel 2.1 Round: one device id, one driver (2026-09-12). The
-- "(native)" id pimoroni.hyperpixel2r_native is retired; the native driver
-- is what pimoroni.hyperpixel2r means now. hardware.device is what the
-- device last reported, so this only keeps the fleet view consistent until
-- the frame's next hello — the device's own frame.json is set from the
-- frame's settings.
UPDATE "frames"
SET "hardware" = jsonb_set("hardware", '{device}', '"pimoroni.hyperpixel2r"'::jsonb)
WHERE "hardware"->>'device' = 'pimoroni.hyperpixel2r_native';
