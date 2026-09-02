import { createDb } from "@frameos-cloud/db";
import { AccountSettingsForm } from "../../../src/components/AccountSettingsForm";
import { AccountSshKeys } from "../../../src/components/AccountSshKeys";
import { storedAccountSettings } from "../../../src/lib/account-settings";
import {
  serviceSettingsFrom,
  sshKeysFrom,
} from "../../../src/lib/account-settings-form";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "Settings" };

// The account's frame settings: the service API keys the apps on your
// frames use, and the SSH public keys the SD card builder installs. These
// used to be a scene of the /frames workspace (the shared SPA's settings
// page in cloud mode); they are account-level facts, so they live with the
// rest of the account. Same storage and API as before (account_settings,
// /api/settings), so nothing a frame receives changed.
export default async function AccountSettingsPage() {
  const session = await readSession();
  const accountId = session?.accountId;
  if (!accountId) {
    return (
      <section className="card">
        <p className="copy">Sign in to manage your settings.</p>
      </section>
    );
  }
  // Masked: the form shows a saved key as `••••••••cdef` and posting that
  // back keeps it (account-settings.ts). The page never holds a real key.
  const stored = await storedAccountSettings(createDb(), accountId);

  return (
    <>
      <section className="section-block">
        <div className="content-header compact-header">
          <div>
            <h2>Service API keys</h2>
            <p className="copy">
              Keys the apps on your frames use — Unsplash photos, Immich
              albums, Home Assistant sensors, OpenAI images and text. Saved
              keys reach your cloud-managed frames on their next check-in.
            </p>
          </div>
        </div>
        <AccountSettingsForm initial={serviceSettingsFrom(stored)} />
      </section>

      <section className="section-block" id="settings-ssh">
        <div className="content-header compact-header">
          <div>
            <h2>SSH keys</h2>
            <p className="copy">
              Public keys the SD card builder installs on new Linux frames, so
              you can log in as root over SSH. The cloud stores public keys
              only.
            </p>
          </div>
        </div>
        <section className="card">
          <AccountSshKeys initialKeys={sshKeysFrom(stored)} />
        </section>
      </section>
    </>
  );
}
