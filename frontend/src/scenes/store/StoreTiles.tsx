import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { PhotoIcon } from '@heroicons/react/24/outline'

import type { TemplateType } from '../../types'
import { imageElementIsBlank } from '../../utils/blankImage'
import { storeShelfForCategory } from '../../utils/storeCategories'
import type { StoreShelfGroup, StoreTagCount } from './storeCatalog'

// The store's tiles and shelves, as the cloud's store page drew them:
// small, 4:3, every fact on the tile. Shared by the signed-in library
// (ScenesLibrary.tsx) and the signed-out store front (PublicStoreFront.tsx).

function TileImage({ imageUrl }: { imageUrl: string | null }): JSX.Element {
  const [unusable, setUnusable] = useState(false)
  useEffect(() => setUnusable(false), [imageUrl])
  return (
    <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border border-slate-500/15 bg-[#1f2937]">
      <PhotoIcon className="h-8 w-8 text-[#3b4757]" aria-hidden="true" />
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
  badge,
  badgeTone,
  showAuthor = true,
  onTag,
  actions,
}: {
  template: TemplateType
  badge?: string
  badgeTone?: 'ok' | 'warn'
  showAuthor?: boolean
  onTag?: (tag: string) => void
  actions?: ReactNode
}): JSX.Element {
  const href = typeof template.url === 'string' && template.url ? template.url : null
  const shelf = template.category ? storeShelfForCategory(template.category) : null
  const tags = (template.tags ?? []).slice(0, 4)
  const flags = template.flags ?? []
  const meta = [
    showAuthor && template.author ? `by ${template.author}` : null,
    template.version ? `v${template.version}` : null,
  ].filter(Boolean)
  const body = (
    <>
      <TileImage imageUrl={typeof template.image === 'string' ? template.image : null} />
      <h3 className="frameos-strong text-sm font-semibold leading-tight">
        {template.name}
        {flags.includes('shell') ? (
          <span
            className="ml-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700"
            title="This scene configures apps or code that run shell commands on the frame"
          >
            runs shell commands
          </span>
        ) : null}
      </h3>
      {template.description ? (
        <p className="frameos-muted line-clamp-2 text-xs leading-snug">{template.description}</p>
      ) : null}
    </>
  )
  return (
    <div className="frameos-card flex flex-col gap-2 rounded-lg border p-2.5 transition hover:border-blue-400">
      {href ? (
        <a
          href={href}
          className="flex flex-col gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {body}
        </a>
      ) : (
        <div className="flex flex-col gap-2">{body}</div>
      )}
      {badge || shelf || tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {badge ? <Pill tone={badgeTone}>{badge}</Pill> : null}
          {shelf ? <Pill>{shelf.title}</Pill> : null}
          {tags.map((tag) => (
            <Pill key={tag} onClick={onTag ? () => onTag(tag) : undefined}>
              {tag}
            </Pill>
          ))}
        </div>
      ) : null}
      {meta.length > 0 ? <div className="frameos-muted mt-auto text-[11px]">{meta.join(' · ')}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
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
  onTag,
}: {
  shelves: StoreShelfGroup[]
  activeCategory: string | null
  emptyMessage: ReactNode
  /** A link to one shelf's page, shown as the shelf title when all shelves are listed. */
  shelfHref?: (slug: string) => string
  onTag?: (tag: string) => void
}): JSX.Element {
  if (shelves.length === 0) {
    return <Note>{emptyMessage}</Note>
  }
  return (
    <>
      {shelves.map(({ shelf, templates }) => (
        <section key={shelf.slug} data-shelf={shelf.slug} className="scroll-mt-4 space-y-3">
          {!activeCategory ? (
            <h2 className="frameos-heading flex items-baseline gap-2 text-lg font-bold">
              {shelfHref ? (
                <a href={shelfHref(shelf.slug)} className="hover:underline">
                  {shelf.title}
                </a>
              ) : (
                shelf.title
              )}
              <span className="frameos-muted text-xs font-medium">{templates.length}</span>
            </h2>
          ) : null}
          <TileGrid>
            {templates.map((template) => (
              <SceneTile key={template.sceneId ?? template.id ?? template.name} template={template} onTag={onTag} />
            ))}
          </TileGrid>
        </section>
      ))}
    </>
  )
}

/** Every tag in the store with its count; the active one is lit. */
export function StoreTagCloud({
  tags,
  activeTag,
  onTag,
}: {
  tags: StoreTagCount[]
  activeTag: string | null
  onTag: (tag: string | null) => void
}): JSX.Element | null {
  if (tags.length === 0) {
    return null
  }
  return (
    <section className="space-y-2">
      <h2 className="frameos-heading text-lg font-bold">Tags</h2>
      <div className="flex flex-wrap gap-1.5">
        {tags.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => onTag(activeTag === tag ? null : tag)}
            className={clsx(
              'frameos-inset rounded-full border px-2.5 py-0.5 text-xs transition hover:border-blue-400',
              activeTag === tag && 'frameos-primary-active border-transparent text-white'
            )}
          >
            {tag} <span className="opacity-60">{count}</span>
          </button>
        ))}
      </div>
    </section>
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
