-- A private scene's share link can be turned off.
--
-- share_token was minted at creation and never written again, so a leaked
-- link was only fixable by deleting the scene or making it public. The
-- owner route now rotates it (a fresh uuid) or clears it (NULL: no link
-- works until one is minted again); shareTokenGrantsAccess already treats
-- a missing token as "nothing grants access".
alter table store_scenes
  alter column share_token drop not null;
