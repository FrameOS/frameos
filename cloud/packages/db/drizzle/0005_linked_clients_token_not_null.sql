-- Every linked client is created with a token reference and rotation always
-- writes a new one, so NULL only ever means a broken row that no backend can
-- authenticate as. Remove any such rows and forbid new ones.
DELETE FROM linked_clients WHERE token_reference IS NULL;

ALTER TABLE linked_clients
  ALTER COLUMN token_reference SET NOT NULL;
