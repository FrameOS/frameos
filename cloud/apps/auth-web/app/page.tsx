import { and, desc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { PublicShell } from "../src/components/PublicShell";
import { SceneCard, type SceneCardScene } from "../src/components/SceneCard";
import { getStoreCategory, storeCategories } from "../src/lib/categories";
import { getAccountUrl, hasDatabaseUrl } from "../src/lib/env";
import { readSession } from "../src/lib/session";
import { accountIsSuperadmin } from "../src/lib/superadmin";

export const metadata = { title: "FrameOS Scenes" };

export const dynamic = "force-dynamic";

const pageSize = 48;

// The store front: every public scene in the registry, featured shelf first,
// then one curated shelf per store category (categories.ts), with simple
// search (name / description / publisher), category/tag filters, and
// pagination.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    page?: string;
    q?: string;
    tag?: string;
  }>;
}) {
  const session = await readSession();
  const isSuperadmin = await accountIsSuperadmin(session?.accountId);
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 100) ?? "";
  const tag = params.tag?.trim().toLowerCase().slice(0, 24) ?? "";
  // Only taxonomy slugs are meaningful filters; anything else is ignored.
  const categoryFilter = getStoreCategory(
    params.category?.trim().toLowerCase(),
  );
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  let scenes: (SceneCardScene & {
    category: string | null;
    featuredAt: Date | null;
  })[] = [];
  let privateScenes: SceneCardScene[] = [];
  let total = 0;
  let allTags: { count: number; name: string }[] = [];
  const categoryCounts = new Map<string, number>();

  if (hasDatabaseUrl()) {
    const db = createDb();
    if (session?.accountId) {
      privateScenes = await db
        .select({
          description: storeScenes.description,
          downloadCount: storeScenes.downloadCount,
          frameosVersion: storeScenes.frameosVersion,
          hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
          id: storeScenes.id,
          name: storeScenes.name,
          publisher: accounts.displayName,
          riskFlags: storeScenes.riskFlags,
          slug: storeScenes.slug,
          tags: storeScenes.tags,
          updatedAt: storeScenes.updatedAt,
        })
        .from(storeScenes)
        .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
        .where(
          and(
            eq(storeScenes.accountId, session.accountId),
            eq(storeScenes.visibility, "private"),
            eq(storeScenes.status, "active"),
            gt(storeScenes.latestVersion, 0),
          ),
        )
        .orderBy(desc(storeScenes.updatedAt));
    }

    const conditions: SQL[] = [
      eq(storeScenes.visibility, "public"),
      eq(storeScenes.status, "active"),
      gt(storeScenes.latestVersion, 0),
    ];
    if (query) {
      const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
      const match = or(
        ilike(storeScenes.name, pattern),
        ilike(storeScenes.description, pattern),
        ilike(accounts.displayName, pattern),
        sql`array_to_string(${storeScenes.tags}, ' ') ilike ${pattern}`,
      );
      if (match) {
        conditions.push(match);
      }
    }
    if (tag) {
      conditions.push(sql`${storeScenes.tags} @> array[${tag}]::text[]`);
    }
    if (categoryFilter) {
      conditions.push(eq(storeScenes.category, categoryFilter.slug));
    }

    const [counted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(storeScenes)
      .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
      .where(and(...conditions));
    total = counted?.count ?? 0;

    scenes = await db
      .select({
        category: storeScenes.category,
        description: storeScenes.description,
        downloadCount: storeScenes.downloadCount,
        frameosVersion: storeScenes.frameosVersion,
        featuredAt: storeScenes.featuredAt,
        hasPreview: sql<boolean>`${storeScenes.previewImage} is not null`,
        id: storeScenes.id,
        name: storeScenes.name,
        publisher: accounts.displayName,
        riskFlags: storeScenes.riskFlags,
        slug: storeScenes.slug,
        tags: storeScenes.tags,
        updatedAt: storeScenes.updatedAt,
      })
      .from(storeScenes)
      .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
      .where(and(...conditions))
      .orderBy(
        sql`${storeScenes.featuredAt} desc nulls last`,
        desc(storeScenes.downloadCount),
        desc(storeScenes.updatedAt),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // Every category and tag in use across public scenes — the filter rows
    // above the shelves (tags most-used first).
    const tagRows = await db
      .select({ category: storeScenes.category, tags: storeScenes.tags })
      .from(storeScenes)
      .where(
        and(
          eq(storeScenes.visibility, "public"),
          eq(storeScenes.status, "active"),
          gt(storeScenes.latestVersion, 0),
        ),
      );
    const tagCounts = new Map<string, number>();
    for (const row of tagRows) {
      if (row.category) {
        categoryCounts.set(
          row.category,
          (categoryCounts.get(row.category) ?? 0) + 1,
        );
      }
      for (const sceneTag of row.tags ?? []) {
        tagCounts.set(sceneTag, (tagCounts.get(sceneTag) ?? 0) + 1);
      }
    }
    allTags = [...tagCounts.entries()]
      .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
      .map(([name, count]) => ({ count, name }));
  }

  // The category shelves only make sense on the unfiltered first page;
  // searches, category/tag filters, and later pages show one flat grid.
  const splitSections = !query && !tag && !categoryFilter && page === 1;
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
          href: `/?category=${encodeURIComponent(category.slug)}`,
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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const pageHref = (target: number) => {
    const search = new URLSearchParams();
    if (query) {
      search.set("q", query);
    }
    if (tag) {
      search.set("tag", tag);
    }
    if (categoryFilter) {
      search.set("category", categoryFilter.slug);
    }
    if (target > 1) {
      search.set("page", String(target));
    }
    const suffix = search.toString();
    return suffix ? `/?${suffix}` : "/";
  };

  return (
    <PublicShell
      isSuperadmin={isSuperadmin}
      signedIn={Boolean(session)}
      title="FrameOS Scenes"
    >
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

      {session?.accountId ? (
        <section className="section-block private-scenes-section">
          <div className="private-scenes-section__header">
            <div>
              <h2>My private scenes</h2>
              <p className="copy">
                Not listed publicly. Only you and people with a sharing link can
                open these scenes.
              </p>
            </div>
            <Link
              className="button button--small button--subtle"
              href={getAccountUrl("/account/scenes")}
            >
              Manage my scenes
            </Link>
          </div>
          {privateScenes.length > 0 ? (
            <div className="grid scene-grid">
              {privateScenes.map((scene) => (
                <SceneCard key={scene.id} scene={scene} />
              ))}
            </div>
          ) : (
            <p className="copy">You do not have any private scenes yet.</p>
          )}
        </section>
      ) : null}

      <form action="/" className="store-search" method="get" role="search">
        <input
          aria-label="Search scenes"
          className="store-search__input"
          defaultValue={query}
          name="q"
          placeholder="Search scenes, descriptions, publishers…"
          type="search"
        />
        <button className="button" type="submit">
          Search
        </button>
      </form>

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
                href={
                  category.slug === categoryFilter?.slug
                    ? "/"
                    : `/?category=${encodeURIComponent(category.slug)}`
                }
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
                  : "All scenes"}
            {tag || categoryFilter ? (
              <>
                {" "}
                <Link className="tag-pill" href="/">
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
            <div className="grid scene-grid">
              {rest.map((scene) => (
                <SceneCard key={scene.id} scene={scene} />
              ))}
            </div>
          ) : (
            <section className="card">
              <p>
                {query
                  ? "No scenes match that search."
                  : categoryFilter
                    ? "No scenes in this category yet."
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

      {totalPages > 1 ? (
        <nav aria-label="Pagination" className="store-pager">
          {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : null}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={pageHref(page + 1)}>Next →</Link>
          ) : null}
        </nav>
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
                href={name === tag ? "/" : `/?tag=${encodeURIComponent(name)}`}
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
