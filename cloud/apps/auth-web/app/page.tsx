import { redirect } from "next/navigation";
import { getFramesUrl, getStorePath } from "../src/lib/env";
import StorePage, { metadata as storeMetadata } from "./store/page";

// Next.js refuses re-exported route config, so these are declared here.
export const metadata = storeMetadata;
export const dynamic = "force-dynamic";

// On the scenes host the root is the store front. When the store shares the
// cloud origin (local development — production's cloud host never reaches
// this page, the surface router sends its root to /frames first) the root
// is the workspace door instead, and the store front lives at /store.
export default async function HomePage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (getStorePath() !== "/") {
    redirect(getFramesUrl());
  }
  return StorePage(props);
}
