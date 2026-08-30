import { NimConverter } from "../../src/components/NimConverter";
import { PublicShell } from "../../src/components/PublicShell";
import {
  getCloudBaseUrl,
  getMyScenesUrl,
  getNimConverterUrl,
} from "../../src/lib/env";
import { readSession } from "../../src/lib/session";
import { accountIsSuperadmin } from "../../src/lib/superadmin";
import { sharedConverterKey } from "../api/scenes/convert/route";

export const metadata = { title: "Nim → JavaScript scene converter" };

export const dynamic = "force-dynamic";

// The Nim → JavaScript scene converter (docs/nim-to-js-conversion.md): drop
// a compiled scene's JSON in, get an interpreted one out. Public — the
// scene is usually on a self-hosted backend whose owner has no account —
// with "Save to my scenes" for those who are signed in.
export default async function NimConverterPage() {
  const session = await readSession();
  const isSuperadmin = await accountIsSuperadmin(session?.accountId);
  const loginUrl = new URL("/login", getCloudBaseUrl());
  loginUrl.searchParams.set("return_to", getNimConverterUrl());
  return (
    <PublicShell
      isSuperadmin={isSuperadmin}
      noCapture
      signedIn={Boolean(session)}
      title="Nim → JavaScript scene converter"
    >
      <NimConverter
        loginUrl={loginUrl.toString()}
        myScenesUrl={getMyScenesUrl()}
        sharedModelPass={Boolean(sharedConverterKey())}
        signedIn={Boolean(session)}
      />
    </PublicShell>
  );
}
