import clsx from 'clsx'
import { STORE_SORT_OPTIONS, storeSortOf, type StoreSort } from '../../utils/storeSort'
import { useEffect, useState, type ReactNode } from 'react'
import { PhotoIcon } from '@heroicons/react/24/outline'
import { A } from 'kea-router'

import type { TemplateType } from '../../types'
import { imageElementIsBlank } from '../../utils/blankImage'
import { templateAccessFlags } from '../../utils/sceneAccess'
import { SceneAccessTags } from '../frame/panels/Scenes/SceneAccessTags'
import { knownSceneNeeds, sceneNeedDescription, sceneNeedLabel } from '../../utils/sceneNeeds'
import { storeShelfDescriptions, type StoreKind } from '../../utils/storeCategories'
import {
  STORE_FIT_OPTIONS,
  STORE_SHELF_PREVIEW_COUNT,
  storeFitOf,
  type StoreFit,
  type StoreKindCounts,
  type StoreShelfGroup,
} from './storeShelves'
import { templateSceneIcon } from '../../utils/sceneIcon'
import { SceneIcon } from '../../components/SceneIcon'

// The store's tiles and shelves, as the cloud's store page drew them:
// small, 4:3. The category is the shelf's heading, not a pill on the tile. Shared by the signed-in library
// (ScenesLibrary.tsx) and the signed-out store front (PublicStoreFront.tsx).

function TileImage({ imageUrl, icon }: { imageUrl: string | null; icon?: string | null }): JSX.Element {
  const [unusable, setUnusable] = useState(false)
  useEffect(() => setUnusable(false), [imageUrl])
  return (
    // Edge to edge at the top of the tile, square at the bottom: the card's
    // own corners round it, nothing frames it.
    <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-slate-500/10">
      {/* The scene's own icon where it has one (docs/scene-icons.md). */}
      {icon ? (
        <SceneIcon path={icon} className="frameos-muted h-10 w-10 opacity-60" />
      ) : (
        <PhotoIcon className="frameos-muted h-8 w-8 opacity-50" aria-hidden="true" />
      )}
      {imageUrl && !unusable ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setUnusable(true)}
          onLoad={(event) => {
            if (imageElementIsBlank(event.currentTarget)) {
              setUnusable(true)
            }
          }}
        />
      ) : null}
    </div>
  )
}

export function Pill({
  children,
  tone,
  onClick,
}: {
  children: ReactNode
  tone?: 'ok' | 'warn'
  onClick?: () => void
}): JSX.Element {
  const className = clsx(
    'frameos-inset inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
    tone === 'ok' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
    tone === 'warn' && 'border-amber-500/40 bg-amber-500/10 text-amber-700',
    onClick && 'cursor-pointer hover:border-blue-400'
  )
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  ) : (
    <span className={className}>{children}</span>
  )
}

/** One scene, as the store page draws it: small, square-ish, every fact on
 * it. The card is one link; the pills beside it are their own buttons. */
export function SceneTile({
  template,
  showAuthor = true,
  actions,
  appHref,
}: {
  template: TemplateType
  showAuthor?: boolean
  actions?: ReactNode
  /** A page of this app the tile opens, for a scene with no `url` of its
   * own (a backend's saved scene opens in the scene editor). */
  appHref?: string
}): JSX.Element {
  const href = typeof template.url === 'string' && template.url ? template.url : null
  const icon = templateSceneIcon(template)
  const flags = templateAccessFlags(template)
  // What it needs of a frame and how it is used (utils/sceneNeeds.ts): a fast
  // screen, touch & mouse, a keyboard, the frame's buttons, a Pi.
  const needs = knownSceneNeeds(template.needs)
  const installs = typeof template.downloads === 'number' && template.downloads > 0 ? template.downloads : null
  const meta = [
    showAuthor && template.author ? `by ${template.author}` : null,
    template.version ? `v${template.version}` : null,
    installs !== null ? `${installs} ${installs === 1 ? 'install' : 'installs'}` : null,
  ].filter(Boolean)
  const body = (
    <>
      <TileImage imageUrl={typeof template.image === 'string' ? template.image : null} icon={icon} />
      <div className="flex flex-col gap-2 px-2.5 pt-2">
        <h3 className="frameos-strong text-base font-semibold leading-snug">
          {icon ? <SceneIcon path={icon} className="mr-1 inline-block h-4 w-4 align-[-2px]" /> : null}
          {template.name}
          {/* The theme's tags, which read on a dark page as on a light one. */}
          <SceneAccessTags flags={flags} className="ml-1 align-middle" tagClassName="!text-[10px] !py-0" />
        </h3>
        {template.description ? (
          <p className="frameos-muted line-clamp-2 text-xs leading-snug">{template.description}</p>
        ) : null}
        {needs.length > 0 ? (
          <div className="flex flex-wrap gap-1" data-scene-needs>
            {needs.map((need) => (
              <span
                key={need}
                className="frameos-inset whitespace-nowrap rounded border px-1 text-[10px] font-medium"
                title={sceneNeedDescription(need)}
              >
                {sceneNeedLabel(need)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </>
  )
  return (
    <div className="frameos-card flex flex-col gap-2 overflow-hidden rounded-lg border border-white/90 pb-2.5 shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50">
      {href ? (
        <a href={href} className="flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          {body}
        </a>
      ) : appHref ? (
        <A href={appHref} className="flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          {body}
        </A>
      ) : (
        <div className="flex flex-col">{body}</div>
      )}
      {meta.length > 0 ? <div className="frameos-muted mt-auto px-2.5 text-[11px]">{meta.join(' · ')}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2 px-2.5">{actions}</div> : null}
    </div>
  )
}

/** The order of the scenes on a store page, next to its Refresh button. */
export function StoreSortSelect({
  value,
  onChange,
}: {
  value: StoreSort
  onChange: (sort: StoreSort) => void
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(storeSortOf(event.target.value))}
      aria-label="Sort scenes"
      title="Sort scenes"
      className="frameos-form-control h-10 rounded-xl border px-3 text-sm font-semibold transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {STORE_SORT_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** Which screens a store page lists scenes for, beside the sort. */
export function StoreFitSelect({
  value,
  onChange,
}: {
  value: StoreFit
  onChange: (fit: StoreFit) => void
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(storeFitOf(event.target.value))}
      aria-label="Screens"
      title="Show the scenes for a kind of screen"
      className="frameos-form-control h-10 rounded-xl border px-3 text-sm font-semibold transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {STORE_FIT_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/** The store's first split: scenes, and the layouts that go around them. */
export function StoreKindTabs({
  kind,
  counts,
  href,
  onPick,
}: {
  kind: StoreKind
  counts: StoreKindCounts
  href: (kind: StoreKind) => string
  onPick: (kind: StoreKind) => void
}): JSX.Element {
  const tabs: { kind: StoreKind; title: string }[] = [
    { kind: 'scene', title: 'Scenes' },
    { kind: 'layout', title: 'Layouts' },
  ]
  return (
    <nav aria-label="Scenes or layouts" className="frameos-inset inline-flex rounded-xl border p-1" data-store-kind>
      {tabs.map((tab) => (
        <a
          key={tab.kind}
          href={href(tab.kind)}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
              event.preventDefault()
              onPick(tab.kind)
            }
          }}
          aria-current={tab.kind === kind ? 'page' : undefined}
          className={clsx(
            'rounded-lg px-3 py-1 text-sm font-semibold transition',
            tab.kind === kind ? 'frameos-primary-active text-white' : 'hover:bg-slate-500/10'
          )}
        >
          {tab.title} <span className="font-medium opacity-60">{counts[tab.kind]}</span>
        </a>
      ))}
    </nav>
  )
}

export function TileGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">{children}</div>
}

export function Note({ children }: { children: ReactNode }): JSX.Element {
  return <div className="frameos-inset rounded-xl border p-4 text-sm leading-relaxed">{children}</div>
}

/** The shelves of a store page, or why there are none. */
export function StoreShelves({
  shelves,
  activeCategory,
  emptyMessage,
  shelfHref,
  tileActions,
}: {
  shelves: StoreShelfGroup[]
  activeCategory: string | null
  emptyMessage: ReactNode
  /** A link to one shelf's page, shown as the shelf title when all shelves are listed. */
  shelfHref?: (slug: string) => string
  /** What a tile ends with (an Install button on the signed-in library). */
  tileActions?: (template: TemplateType) => ReactNode
}): JSX.Element {
  // Every shelf listed: each shows its first tiles and links to the rest.
  const limit = activeCategory ? null : STORE_SHELF_PREVIEW_COUNT
  if (shelves.length === 0) {
    return <Note>{emptyMessage}</Note>
  }
  return (
    <>
      {shelves.map(({ shelf, templates }) => (
        <section key={shelf.slug} data-shelf={shelf.slug} className="scroll-mt-4 space-y-3">
          {!activeCategory ? (
            <h2 className="frameos-heading flex items-baseline gap-2 text-2xl font-bold">
              {shelfHref ? (
                <a href={shelfHref(shelf.slug)} className="hover:underline">
                  {shelf.title}
                </a>
              ) : (
                shelf.title
              )}
              <span className="frameos-muted text-sm font-medium">{templates.length}</span>
            </h2>
          ) : null}
          {!activeCategory && storeShelfDescriptions[shelf.slug] ? (
            <p className="frameos-muted -mt-2 text-sm leading-relaxed">{storeShelfDescriptions[shelf.slug]}</p>
          ) : null}
          <TileGrid>
            {(limit === null ? templates : templates.slice(0, limit)).map((template) => (
              <SceneTile
                key={template.sceneId ?? template.id ?? template.name}
                template={template}
                actions={tileActions?.(template)}
              />
            ))}
          </TileGrid>
          {limit !== null && templates.length > limit && shelfHref ? (
            <a
              href={shelfHref(shelf.slug)}
              className="frameos-inset inline-flex rounded-xl border px-3 py-1.5 text-sm font-semibold hover:border-blue-400"
              data-shelf-more
            >
              See all {templates.length} in {shelf.title}
            </a>
          ) : null}
        </section>
      ))}
    </>
  )
}

/** The shelf whose top has scrolled past the top of the page (an offset in
 * from the scroller's edge), for a side panel that follows the page. */
export function watchVisibleShelf(container: HTMLElement | null, onChange: (slug: string | null) => void): () => void {
  if (typeof document === 'undefined') {
    return () => undefined
  }
  const main = document.querySelector<HTMLElement>('[data-workspace-main]')
  // The element that scrolls: the shell's <main> when it does, else the window.
  const scrollingMain = main && main.scrollHeight > main.clientHeight ? main : null
  const scroller: HTMLElement | Window = scrollingMain ?? window
  let frame = 0
  const update = () => {
    frame = 0
    const sections = container?.querySelectorAll<HTMLElement>('[data-shelf]') ?? []
    const top = (scrollingMain ? scrollingMain.getBoundingClientRect().top : 0) + 120
    let current: string | null = null
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= top) {
        current = section.dataset.shelf ?? null
      }
    }
    onChange(current)
  }
  const onScroll = () => {
    if (!frame) {
      frame = window.requestAnimationFrame(update)
    }
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  update()
  return () => {
    scroller.removeEventListener('scroll', onScroll)
    if (frame) {
      window.cancelAnimationFrame(frame)
    }
    onChange(null)
  }
}

/** The page scrolls inside the shell's <main> on wide screens and with the
 * window on narrow ones; both go to the top when the page changes. */
export function scrollStoreToTop(): void {
  if (typeof document === 'undefined') {
    return
  }
  document.querySelector('[data-workspace-main]')?.scrollTo({ top: 0 })
  window.scrollTo({ top: 0 })
}
