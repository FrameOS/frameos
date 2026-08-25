import { and, eq, gt } from "drizzle-orm";
import Link from "next/link";
import { createDb, storeScenes } from "@frameos-cloud/db";
import { PublicShell } from "../../src/components/PublicShell";
import { SceneCard, type SceneCardScene } from "../../src/components/SceneCard";
import { StoreSceneFeed } from "../../src/components/StoreSceneFeed";
import { StoreTabs } from "../../src/components/StoreTabs";
import { StoreVersionSelect } from "../../src/components/StoreVersionSelect";
import { getStoreCategory, storeCategories } from "../../src/lib/categories";
import { CreateSceneWithAiBox } from "../../src/components/CreateSceneWithAiBox";
import {
  getScenesBaseUrl,
  getStorePath,
  hasDatabaseUrl,
  myScenesPath,
} from "../../src/lib/env";
import { readSession } from "../../src/lib/session";
import {
  countStoreScenes,
  listStoreScenes,
  serializeStoreScene,
  type StoreBrowseRow,
} from "../../src/lib/store-browse";
import {
  parseStoreBrowseFilters,
  parseStorePage,
  storeBrowseHref,
  storeHasFilters,
  storePageSize,
  type StoreBrowseParams,
} from "../../src/lib/store-filters";
import {
  frameosVersionSatisfies,
  normalizeRequestedFrameosVersion,
  sortFrameosVersionsDesc,
} from "../../src/lib/store-versions";
import { accountIsSuperadmin } from "../../src/lib/superadmin";

export const metadata = { title: "FrameOS Scenes" };

export const dynamic = "force-dynamic";

// The store front: every public scene in the registry, featured shelf first,
// then one curated shelf per store category (categories.ts), with simple
// search (name / description / publisher), category/tag/FrameOS-version
// filters, and a lazily loaded list (the first page is server-rendered, the
// rest streams in from /api/store/browse as you scroll).
//
// Served at / on the scenes host and at /store when the store shares the
// cloud origin (app/page.tsx decides; see env.ts getStorePath()).
export default async function StorePage({
  searchParams,
}: {
  searchParams: Promise<StoreBrowseParams>;
}) {
  const storePath = getStorePath();
  const newSceneUrl = new URL(`${myScenesPath}/new`, getScenesBaseUrl()).toString();
  const session = await readSession();
  const isSuperadmin = await accountIsSuperadmin(session?.accountId);
  const params = await searchParams;
  const filters = parseStoreBrowseFilters(params);
  const { query, tag, version } = filters;
  const categoryFilter = getStoreCategory(filters.category);
  const page = parseStorePage(params.page);

  let scenes: StoreBrowseRow[] = [];
  let total = 0;
  let allTags: { count: number; name: string }[] = [];
  const categoryCounts = new Map<string, number>();
  // Every FrameOS version declared by a public scene, newest first, with the
  // number of scenes that run on it (a scene runs on every version at or
  // above its own minimum, so these counts are cumulative).
  let versionOptions: { count: number; version: string }[] = [];

  if (hasDatabaseUrl()) {
    const db = createDb();
    total = await countStoreScenes(db, filters);
    scenes = await listStoreScenes(db, filters, page);

    // Every category, tag and declared FrameOS version in use across public
    // scenes — the filter rows above the shelves (tags most-used first).
    const facetRows = await db
      .select({
        category: storeScenes.category,
        frameosVersion: storeScenes.frameosVersion,
        tags: storeScenes.tags,
      })
      .from(storeScenes)
      .where(
        and(
          eq(storeScenes.visibility, "public"),
          eq(storeScenes.status, "active"),
          gt(storeScenes.latestVersion, 0),
        ),
      );
    const tagCounts = new Map<string, number>();
    const declaredVersions: (string | null)[] = [];
    for (const row of facetRows) {
      if (row.category) {
        categoryCounts.set(
          row.category,
          (categoryCounts.get(row.category) ?? 0) + 1,
        );
      }
      declaredVersions.push(row.frameosVersion);
      for (const sceneTag of row.tags ?? []) {
        tagCounts.set(sceneTag, (tagCounts.get(sceneTag) ?? 0) + 1);
      }
    }
    allTags = [...tagCounts.entries()]
      .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
      .map(([name, count]) => ({ count, name }));
    versionOptions = sortFrameosVersionsDesc(
      declaredVersions
        // Only plain dotted versions make usable filters (and usable
        // repository URLs); "nightly" or "2026.9.0-rc1" are not offered.
        .map((value) => normalizeRequestedFrameosVersion(value))
        .filter((value): value is string => Boolean(value)),
    ).map((value) => ({
      count: declaredVersions.filter((declared) =>
        frameosVersionSatisfies(declared, value),
      ).length,
      version: value,
    }));
  }

  // The category shelves only make sense on the unfiltered first page;
  // searches, category/tag/version filters, and later pages show one flat
  // grid.
  const splitSections = !storeHasFilters(filters) && page === 1;
  const featured = splitSections
    ? scenes.filter((scene) => scene.featuredAt !== null)
    : [];
  const rest = splitSections
    ? scenes.filter((scene) => scene.featuredAt === null)
    : scenes;
  // Non-featured scenes shelve by their category (categories.ts, taxonomy
  // order); anything uncategorized lands in the final bucket so nothing ever
  // disappears from the front page. Every shelf lists its scenes
  // alphabetically.
  const byName = (a: SceneCardScene, b: SceneCardScene) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sections = splitSections
    ? [
        {
          description: "Hand-picked scenes and fresh arrivals worth a look.",
          href: undefined as string | undefined,
          scenes: [...featured].sort(byName),
          title: "New & featured",
        },
        ...storeCategories.map((category) => ({
          description: category.description,
          href: storeBrowseHref(
            { ...filters, category: category.slug },
            1,
            storePath,
          ),
          scenes: rest
            .filter((scene) => scene.category === category.slug)
            .sort(byName),
          title: category.title,
        })),
        {
          description: "Scenes that have not been categorized yet.",
          href: undefined as string | undefined,
          scenes: rest
            .filter((scene) => !getStoreCategory(scene.category))
            .sort(byName),
          title: "More scenes",
        },
      ].filter((section) => section.scenes.length > 0)
    : [];
  const totalPages = Math.max(1, Math.ceil(total / storePageSize));

  return (
    <PublicShell isSuperadmin={isSuperadmin} signedIn={Boolean(session)}>
      {/* The private list is the store's second tab; it needs an account. */}
      {session?.accountId ? (
        <StoreTabs active="store" />
      ) : (
        // Signed-in visitors know what FrameOS is; the tabs take the slot.
        <div className="content-header">
          <div>
            <p className="copy">
              These scenes can be run on FrameOS devices.{" "}
              <a href="https://frameos.net" rel="noreferrer noopener">
                Learn more about FrameOS here.
              </a>
            </p>
          </div>
        </div>
      )}

      <form
        action={storePath}
        className="store-search"
        method="get"
        role="search"
      >
        <input
          aria-label="Search scenes"
          className="store-search__input"
          defaultValue={query}
          name="q"
          placeholder="Search scenes, descriptions, publishers…"
          type="search"
        />
        {/* Keep the other filters when the search form navigates. */}
        {filters.category ? (
          <input name="category" type="hidden" value={filters.category} />
        ) : null}
        {tag ? <input name="tag" type="hidden" value={tag} /> : null}
        {versionOptions.length > 0 ? (
          <StoreVersionSelect filters={filters} options={versionOptions} />
        ) : version ? (
          <input name="version" type="hidden" value={version} />
        ) : null}
        <button className="button" type="submit">
          Search
        </button>
      </form>

      <CreateSceneWithAiBox action={newSceneUrl} />

      {categoryCounts.size > 0 ? (
        <div className="tag-list store-tag-row">
          {storeCategories
            .filter((category) => (categoryCounts.get(category.slug) ?? 0) > 0)
            .map((category) => (
              <Link
                aria-current={
                  category.slug === categoryFilter?.slug ? "true" : undefined
                }
                className={
                  category.slug === categoryFilter?.slug
                    ? "tag-pill tag-pill--active"
                    : "tag-pill"
                }
                href={storeBrowseHref(
                  {
                    ...filters,
                    category:
                      category.slug === categoryFilter?.slug
                        ? ""
                        : category.slug,
                  },
                  1,
                  storePath,
                )}
                key={category.slug}
              >
                {category.title}{" "}
                <span className="tag-pill__count">
                  {categoryCounts.get(category.slug)}
                </span>
              </Link>
            ))}
        </div>
      ) : null}

      {sections.map((section) => (
        <section className="section-block" key={section.title}>
          <h2>
            {section.href ? (
              <Link href={section.href}>{section.title}</Link>
            ) : (
              section.title
            )}
          </h2>
          <p className="copy section-description">{section.description}</p>
          <div className="grid scene-grid">
            {section.scenes.map((scene) => (
              <SceneCard key={scene.id} scene={scene} />
            ))}
          </div>
        </section>
      ))}

      {!splitSections ? (
        <section className="section-block">
          <h2>
            {query
              ? `Results for “${query}”`
              : categoryFilter
                ? categoryFilter.title
                : tag
                  ? `Scenes tagged “${tag}”`
                  : version
                    ? `Scenes for FrameOS ${version}`
                    : "All scenes"}
            {tag || categoryFilter || version ? (
              <>
                {" "}
                <Link className="tag-pill" href={storePath}>
                  clear filter
                </Link>
              </>
            ) : null}
          </h2>
          {categoryFilter && !query ? (
            <p className="copy section-description">
              {categoryFilter.description}
            </p>
          ) : null}
          {rest.length > 0 ? (
            // Server-rendered first page; the feed appends the next ones.
            <StoreSceneFeed
              basePath={storePath}
              filters={filters}
              initialScenes={rest.map(serializeStoreScene)}
              loadedPage={page}
              totalPages={totalPages}
            />
          ) : (
            <section className="card">
              <p>
                {query
                  ? "No scenes match that search."
                  : categoryFilter
                    ? "No scenes in this category yet."
                    : version
                      ? `No scenes run on FrameOS ${version} yet.`
                      : "No scenes carry that tag."}
              </p>
            </section>
          )}
        </section>
      ) : null}

      {splitSections && scenes.length === 0 ? (
        <section className="card">
          <p>
            Nothing published yet. Link a FrameOS backend, enable store
            publishing, and share the first scene.
          </p>
        </section>
      ) : null}

      {splitSections ? (
        // The shelves above are built from the first page; everything past it
        // loads as you scroll.
        <StoreSceneFeed
          basePath={storePath}
          filters={filters}
          heading="More from the store"
          initialScenes={[]}
          loadedPage={1}
          totalPages={totalPages}
        />
      ) : null}

      {/* The full tag cloud lives at the very bottom: with auto-tagging
          there are too many tags to headline the page — categories are the
          primary navigation now. */}
      {allTags.length > 0 ? (
        <section className="section-block">
          <h2>Browse by tag</h2>
          <div className="tag-list store-tag-row">
            {allTags.map(({ count, name }) => (
              <Link
                aria-current={name === tag ? "true" : undefined}
                className={
                  name === tag ? "tag-pill tag-pill--active" : "tag-pill"
                }
                href={storeBrowseHref(
                  { ...filters, tag: name === tag ? "" : name },
                  1,
                  storePath,
                )}
                key={name}
              >
                {name} <span className="tag-pill__count">{count}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </PublicShell>
  );
}
