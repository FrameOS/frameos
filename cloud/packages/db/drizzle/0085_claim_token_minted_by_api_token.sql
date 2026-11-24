-- A claim token minted with a personal API token (a script's credential, not
-- the person's) never enrolls a frame as `active`: its enrollment is born
-- `pending` and waits for the owner's Confirm click in the browser, as every
-- enrollment of a multi-use token does. Tokens minted before this column
-- existed keep the old rule.

ALTER TABLE "frame_enrollment_tokens" ADD COLUMN "minted_by_api_token" boolean DEFAULT false NOT NULL;
