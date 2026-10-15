import { useActions, useMountedLogic, useValues } from 'kea'
import { router } from 'kea-router'
import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import { MagnifyingGlassIcon, MoonIcon, SunIcon } from '@heroicons/react/24/outline'

import { Spinner } from '../../components/Spinner'
import { urls } from '../../urls'
import { authThemeLogic } from '../auth/authThemeLogic'
import { storeShelfForCategory } from '../../utils/storeCategories'
import { publicStoreLogic } from './publicStoreLogic'
import { StoreShelves, scrollStoreToTop, watchVisibleShelf } from './StoreTiles'

// The scene store for a visitor without a session: the cloud's /store and
// the scenes host's root. The same shelves the signed-in library shows,
// without the workspace around them — a slim header with a search box and
// a way to sign in, the categories as a row of pills, the shelves. Opening a scene goes to its page, which signs the visitor in when
// it needs to.

function injected(key: string): string | undefined {
  const value = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.[key] : undefined
  return typeof value === 'string' && value ? value : undefined
}

export function PublicStoreFront(): JSX.Element {
  useMountedLogic(authThemeLogic)
  const { theme } = useValues(authThemeLogic)
  const { toggleTheme } = useActions(authThemeLogic)
  const {
    storeShelves,
    storeScenesCount,
    storeShelfCounts,
    storeOrigin,
    repositoriesLoading,
    search,
    category,
    visibleShelf,
  } = useValues(publicStoreLogic)
  const { setSearch, setVisibleShelf } = useActions(publicStoreLogic)
  const shelvesRef = useRef<HTMLDivElement>(null)
  const goTo = (filters: { category?: string | null }) =>
    router.actions.push(urls.scenesHome('store', { category, ...filters }))
  const highlightedCategory = category ?? visibleShelf
  const activeShelf = category ? storeShelfForCategory(category) : null
  const loginUrl = injected('cloud_login_url') ?? '/login'

  useEffect(() => {
    scrollStoreToTop()
  }, [category])
  useEffect(() => {
    if (category) {
      return
    }
    return watchVisibleShelf(shelvesRef.current, setVisibleShelf)
  }, [category, storeShelves.length, setVisibleShelf])

  return (
    // The app root clips at the viewport (#root is overflow: hidden, every
    // workspace page scrolls inside its own column), so the store front
    // scrolls inside the shell too; the header sticks inside it.
    <div className={clsx('frameos-app-shell h-screen overflow-hidden text-slate-900', `frameos-theme-${theme}`)}>
      <div className="h-full overflow-y-auto">
        <header className="frameos-panel sticky top-0 z-20 border-b border-white/80 bg-white/90 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
            <a href={urls.scenesHome('store')} className="flex items-center gap-2" title="FrameOS Cloud scene store">
              <img alt="" src={theme === 'dark' ? '/logo-dark.svg' : '/logo-light.svg'} className="h-7 w-auto" />
              <span className="frameos-strong text-base font-bold">FrameOS Cloud</span>
              <span className="frameos-muted text-sm">Scene store</span>
            </a>
            <div className="relative min-w-0 flex-1 basis-56">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search scenes..."
                className="frameos-input h-10 w-full rounded-xl border bg-white/90 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <a
              href={`${storeOrigin}/my-scenes/new`}
              className="frameos-form-control flex h-10 items-center rounded-xl border px-3 text-sm font-semibold transition hover:bg-slate-50"
            >
              Create a scene with AI
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="frameos-form-control flex h-10 w-10 items-center justify-center rounded-xl border transition hover:bg-slate-50"
            >
              {theme === 'dark' ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
            </button>
            <a
              href={loginUrl}
              className="frameos-primary-action flex h-10 items-center rounded-xl px-4 text-sm font-semibold text-white"
            >
              Sign in
            </a>
          </div>
        </header>
        <main className="mx-auto max-w-6xl space-y-8 px-4 pb-16 pt-6 @container">
          <div>
            <h1 className="frameos-strong text-3xl font-bold tracking-normal">
              {activeShelf ? activeShelf.title : 'Public scene store'}
            </h1>
            <p className="frameos-muted mt-1 max-w-3xl text-sm leading-relaxed">
              Ready-made scenes from the FrameOS community. Open one to see it in the editor, sign in to save your own
              and install them on your frames.
            </p>
          </div>
          {storeShelfCounts.length > 0 ? (
            <nav aria-label="Categories" className="flex flex-wrap gap-1.5">
              {[{ slug: null as string | null, title: 'All scenes', count: storeScenesCount }]
                .concat(storeShelfCounts.map(({ shelf, count }) => ({ slug: shelf.slug, title: shelf.title, count })))
                .map((entry) => (
                  <a
                    key={entry.slug ?? 'all'}
                    href={urls.scenesHome('store', { category: entry.slug })}
                    onClick={(event) => {
                      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
                        event.preventDefault()
                        goTo({ category: entry.slug })
                      }
                    }}
                    aria-current={(entry.slug ?? null) === (highlightedCategory ?? null) ? 'page' : undefined}
                    className={clsx(
                      'frameos-inset rounded-full border px-3 py-1 text-sm transition hover:border-blue-400',
                      (entry.slug ?? null) === (highlightedCategory ?? null) &&
                        'frameos-primary-active border-transparent text-white'
                    )}
                  >
                    {entry.title} <span className="opacity-60">{entry.count}</span>
                  </a>
                ))}
            </nav>
          ) : null}
          <div className="space-y-8" ref={shelvesRef}>
            {repositoriesLoading && storeScenesCount === 0 ? (
              <div className="frameos-muted flex items-center gap-2 text-sm">
                <Spinner className="h-4 w-4" />
                Loading the scene store…
              </div>
            ) : (
              <StoreShelves
                shelves={storeShelves}
                activeCategory={category}
                shelfHref={(slug) => urls.scenesHome('store', { category: slug })}
                emptyMessage={
                  storeScenesCount === 0
                    ? 'The scene store is not available right now.'
                    : `No store scenes match "${search}".`
                }
              />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

export default PublicStoreFront
