import { redirect } from "next/navigation";
import { getAccountUrl } from "../../src/lib/env";

// The overview page is gone — its headline numbers live in the account
// header as tags. Land on the first real section instead: frames, which is
// what the account is mostly about and the first tab in the nav.
export default function AccountPage() {
  redirect(getAccountUrl("/account/frames"));
}
