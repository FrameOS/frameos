import { redirect } from "next/navigation";
import { getAccountUrl } from "../../src/lib/env";

// The overview page is gone — its headline numbers live in the account
// header as tags. Land on the first real section instead.
export default function AccountPage() {
  redirect(getAccountUrl("/account/installs"));
}
