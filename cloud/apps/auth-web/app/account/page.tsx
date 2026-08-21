import { redirect } from "next/navigation";
import { getAccountUrl } from "../../src/lib/env";

// The overview page is gone — its headline numbers live in the account
// header as tags. Land on the first real section instead. Frames and scenes
// have their own surfaces (the /frames workspace and the scene store), so the
// account is about backends, backups, activity and security.
export default function AccountPage() {
  redirect(getAccountUrl("/account/installs"));
}
