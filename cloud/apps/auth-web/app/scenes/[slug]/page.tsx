import { permanentRedirect } from "next/navigation";

type LegacyScenePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ share?: string; version?: string }>;
};

// Keep published links and bookmarks working while making /s/:slug the
// canonical, compact scene URL.
export default async function LegacyScenePage({
  params,
  searchParams,
}: LegacyScenePageProps) {
  const { slug } = await params;
  const { share, version } = await searchParams;
  const query = new URLSearchParams();
  if (version) {
    query.set("version", version);
  }
  if (share) {
    query.set("share", share);
  }
  const suffix = query.toString();
  permanentRedirect(
    `/s/${encodeURIComponent(slug)}${suffix ? `?${suffix}` : ""}`,
  );
}
