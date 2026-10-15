import { useValues } from 'kea'
import { A } from 'kea-router'
import type { ReactNode } from 'react'
import { ComputerDesktopIcon, FolderIcon, PhotoIcon, RectangleGroupIcon } from '@heroicons/react/24/outline'

import { FrameImage } from '../../components/FrameImage'
import { Spinner } from '../../components/Spinner'
import { frameHost, frameStatusDescription } from '../../decorators/frame'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
import { photoThumbUrl, type PhotoEntry } from '../photos/photosApi'
import { formatBytes } from '../settings/account/format'
import { FrameosShell } from '../workspace/FrameosShell'
import { cloudHomeLogic, HOME_SECTION_LIMIT } from './cloudHomeLogic'
import { SceneTile, TileGrid as SceneTileGrid } from '../store/StoreTiles'

// The cloud's home page, behind the rail's logo: a greeting, then the
// frames, the store's scenes, the private scenes and the albums (a few of
// each, then "See all") and the account's usage at a glance. Everything on
// it is a door into the page that owns it.

function Section({
  title,
  count,
  seeAllHref,
  children,
}: {
  title: string
  count: number
  seeAllHref: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="frameos-heading text-xl font-bold">{title}</h2>
        <A href={seeAllHref} className="frameos-muted text-sm font-semibold underline-offset-2 hover:underline">
          {count > HOME_SECTION_LIMIT ? `See all ${count}` : 'See all'}
        </A>
      </div>
      {children}
    </section>
  )
}

function TileGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">{children}</div>
}

function FrameTile({ frame }: { frame: FrameType }): JSX.Element {
  return (
    <A
      href={urls.frame(frame.id)}
      className="frameos-card flex flex-col gap-2 rounded-lg border p-2.5 transition hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <FrameImage
        frameId={frame.id}
        thumb
        refreshable={false}
        className="aspect-[4/3] w-full overflow-hidden rounded-md border border-slate-500/15 bg-[#1f2937]"
        objectFit="cover"
      />
      <div className="frameos-strong truncate text-sm font-semibold">{frame.name || frameHost(frame)}</div>
      <div className="frameos-muted truncate text-xs">{frameStatusDescription(frame)}</div>
    </A>
  )
}

function AlbumTile({ album }: { album: PhotoEntry }): JSX.Element {
  const files = album.files ?? album.items ?? 0
  return (
    <A
      href={urls.photos(album.path)}
      className="frameos-card flex flex-col gap-2 rounded-lg border p-2.5 transition hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border border-slate-500/15 bg-[#1f2937]">
        <PhotoIcon className="h-8 w-8 text-[#3b4757]" aria-hidden="true" />
        {album.cover ? (
          <img
            src={photoThumbUrl({ path: album.cover, mtime: album.mtime, size: album.size })}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="frameos-strong truncate text-sm font-semibold">{album.name}</div>
      <div className="frameos-muted text-xs">{files === 1 ? '1 photo' : `${files} photos`}</div>
    </A>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }): JSX.Element {
  return (
    <div className="frameos-card rounded-xl border p-4">
      <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className="frameos-strong mt-1 text-2xl font-bold">{value}</div>
      {detail ? <div className="frameos-muted mt-0.5 text-xs">{detail}</div> : null}
    </div>
  )
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="frameos-inset flex items-center gap-3 rounded-xl border p-4 text-sm">
      <span className="frameos-muted [&>svg]:h-6 [&>svg]:w-6">{icon}</span>
      <span>{children}</span>
    </div>
  )
}

export function CloudHome(): JSX.Element {
  const {
    greetingName,
    usage,
    usageResponseLoading,
    recentFrames,
    framesList,
    framesEverLoaded,
    recentAlbums,
    albums,
    albumsLoading,
    storeTemplates,
    recentStoreScenes,
    repositoriesLoading,
    driveTemplates,
    recentPrivateScenes,
    driveTemplatesLoading,
  } = useValues(cloudHomeLogic)

  return (
    <FrameosShell mode="home" title="Home" browserTitle="Home" tree={null} topBar={null} showAiButton={false}>
      <div className="mx-auto max-w-6xl space-y-10 pb-16 @container">
        <header>
          <h1 className="frameos-strong text-3xl font-bold tracking-normal">FrameOS Cloud</h1>
          <p className="frameos-muted mt-1 text-sm leading-relaxed">
            {greetingName ? `Hello ${greetingName}. ` : ''}Your frames, your scenes and your photos, in one place.
          </p>
        </header>

        <Section title="Frames" count={framesList.length} seeAllHref={urls.frames()}>
          {!framesEverLoaded ? (
            <div className="frameos-muted flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              Loading frames…
            </div>
          ) : recentFrames.length === 0 ? (
            <Empty icon={<ComputerDesktopIcon />}>
              No frames yet.{' '}
              <A href={urls.frames()} className="font-semibold underline-offset-2 hover:underline">
                Add your first frame
              </A>
              .
            </Empty>
          ) : (
            <TileGrid>
              {recentFrames.map((frame) => (
                <FrameTile key={frame.id} frame={frame} />
              ))}
            </TileGrid>
          )}
        </Section>

        <Section title="Scenes" count={storeTemplates.length} seeAllHref={urls.scenesHome('store')}>
          {repositoriesLoading && storeTemplates.length === 0 ? (
            <div className="frameos-muted flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              Loading the scene store…
            </div>
          ) : recentStoreScenes.length === 0 ? (
            <Empty icon={<RectangleGroupIcon />}>The scene store is not available right now.</Empty>
          ) : (
            <SceneTileGrid>
              {recentStoreScenes.map((template) => (
                <SceneTile key={template.sceneId ?? template.id ?? template.name} template={template} />
              ))}
            </SceneTileGrid>
          )}
        </Section>

        <Section title="Private scenes" count={driveTemplates.length} seeAllHref={urls.scenesHome('cloud')}>
          {driveTemplatesLoading && driveTemplates.length === 0 ? (
            <div className="frameos-muted flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              Loading your scenes…
            </div>
          ) : recentPrivateScenes.length === 0 ? (
            <Empty icon={<RectangleGroupIcon />}>
              No private scenes yet.{' '}
              <A href={urls.scenesHome('cloud')} className="font-semibold underline-offset-2 hover:underline">
                Make one
              </A>
              .
            </Empty>
          ) : (
            <SceneTileGrid>
              {recentPrivateScenes.map((template) => (
                <SceneTile
                  key={template.sceneId ?? template.id ?? template.name}
                  template={template}
                  showAuthor={false}
                  badge={template.visibility === 'public' ? 'Public' : 'Private'}
                  badgeTone={template.visibility === 'public' ? 'ok' : undefined}
                />
              ))}
            </SceneTileGrid>
          )}
        </Section>

        <Section title="Photos" count={albums.length} seeAllHref={urls.photos()}>
          {albumsLoading && albums.length === 0 ? (
            <div className="frameos-muted flex items-center gap-2 text-sm">
              <Spinner className="h-4 w-4" />
              Loading albums…
            </div>
          ) : recentAlbums.length === 0 ? (
            <Empty icon={<FolderIcon />}>
              No albums yet.{' '}
              <A href={urls.photos()} className="font-semibold underline-offset-2 hover:underline">
                Make one in Photos
              </A>
              .
            </Empty>
          ) : (
            <TileGrid>
              {recentAlbums.map((album) => (
                <AlbumTile key={album.path} album={album} />
              ))}
            </TileGrid>
          )}
        </Section>

        <Section title="Usage" count={0} seeAllHref={urls.accountUsage()}>
          {!usage ? (
            <div className="frameos-muted flex items-center gap-2 text-sm">
              {usageResponseLoading ? <Spinner className="h-4 w-4" /> : null}
              {usageResponseLoading ? 'Loading usage…' : 'Usage is not available right now.'}
            </div>
          ) : (
            <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
              <Stat label="Frames" value={`${usage.frames.count}`} detail={`of ${usage.frames.max_count}`} />
              <Stat
                label="Photos"
                value={formatBytes(usage.photos.bytes)}
                detail={`of ${formatBytes(usage.photos.max_bytes)}`}
              />
              <Stat
                label="Private scenes"
                value={formatBytes(usage.scenes.private_bytes)}
                detail={`of ${formatBytes(usage.scenes.private_max_bytes)}`}
              />
              <Stat
                label="AI this month"
                value={`${usage.ai.turns_this_month} ${usage.ai.turns_this_month === 1 ? 'turn' : 'turns'}`}
                detail={usage.plan.name}
              />
            </div>
          )}
        </Section>
      </div>
    </FrameosShell>
  )
}

export default CloudHome
