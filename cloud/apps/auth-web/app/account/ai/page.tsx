import { redirect } from "next/navigation";
import { getAccountUrl } from "../../../src/lib/env";

// AI usage moved onto the usage page (app/account/usage), below storage and
// frames; old links and bookmarks land there.
export default function AccountAiPage() {
  redirect(getAccountUrl("/account/usage#ai"));
}
