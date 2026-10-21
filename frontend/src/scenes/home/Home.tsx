import { useValues } from 'kea'
import { A } from 'kea-router'
import type { ReactNode } from 'react'
import { ComputerDesktopIcon, FolderIcon, PhotoIcon, RectangleGroupIcon } from '@heroicons/react/24/outline'

import { FrameImage } from '../../components/FrameImage'
import { FrameosLogo } from '../../components/FrameosLogo'
import { Spinner } from '../../components/Spinner'
import { frameHost, frameStatusDescription } from '../../decorators/frame'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
import { isCloudMode } from '../../utils/cloudMode'
import { photoThumbUrl, type PhotoEntry } from '../photos/photosApi'
import { formatBytes } from '../settings/account/format'
import { FrameosShell } from '../workspace/FrameosShell'
import { photosLibraryIsAvailable, scenesLibraryPageLabel } from '../workspace/workspaceSurfaces'
import { backendHomeLogic, backendVersion } from './backendHomeLogic'
import { cloudHomeLogic } from './cloudHomeLogic'
import { homeLogic } from './homeLogic'
import { SceneTile } from '../store/StoreTiles'
import { workspaceLogic } from '../workspace/workspaceLogic'

// The home page behind the rail's logo, on the cloud and on a backend: a
// greeting, then the frames, the store's scenes, the private scenes and the
// albums (a few of each, then "See all") and the numbers at a glance (the
// cloud's usage, a backend's fleet). Everything on it is a door into the page
// that owns it.

function Section({
  title,
  count,
  seeAllHref,
  children,
}: {
  title: string
  count: number
  seeAllHref?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="frameos-heading text-xl font-bold">{title}</h2>
        {seeAllHref ? (
          <A href={seeAllHref} className="frameos-muted text-sm font-semibold underline-offset-2 hover:underline">
            {count > 0 ? `See all ${count}` : 'See all'}
          </A>
        ) : null}
      </div>
      {children}
    </section>
  )
}

// One row, however wide the screen: the columns fill the width and every
// row after the first collapses to nothing. "See all" has the rest.
function OneRowGrid({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="grid gap-x-3 gap-y-0 overflow-hidden [grid-auto-rows:0] [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))] [grid-template-rows:auto]">
      {children}
    </div>
  )
}

function FrameTile({ frame }: { frame: FrameType }): JSX.Element {
  return (
    <A
      href={urls.frame(frame.id)}
      className="frameos-card flex flex-col gap-2 rounded-lg border p-2.5 transition hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {/* max-w-full keeps FrameImage's own h-full off: in the one-row grid it
          takes the row's height and squeezes the two lines below it. */}
      <FrameImage
        frameId={frame.id}
        thumb
        refreshable={false}
        className="aspect-[4/3] w-full max-w-full overflow-hidden rounded-md border border-slate-500/15 bg-[#1f2937]"
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

function Loading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="frameos-muted flex items-center gap-2 text-sm">
      <Spinner className="h-4 w-4" />
      {children}
    </div>
  )
}

function HomeHeader({
  logo,
  title,
  greetingName,
}: {
  logo: ReactNode
  title: string
  greetingName: string
}): JSX.Element {
  return (
    <header className="flex items-center gap-4">
      {logo}
      <div className="min-w-0">
        <h1 className="frameos-strong text-3xl font-bold tracking-normal">{title}</h1>
        <p className="frameos-muted mt-1 text-sm leading-relaxed">
          {greetingName ? `Hello ${greetingName}. ` : ''}Your frames, your scenes and your photos, in one place.
        </p>
      </div>
    </header>
  )
}

function CloudHomeHeader(): JSX.Element {
  const { theme } = useValues(workspaceLogic)
  const { greetingName } = useValues(cloudHomeLogic)
  return (
    <HomeHeader
      logo={
        <img alt="" src={theme === 'dark' ? '/logo-dark.svg' : '/logo-light.svg'} className="h-12 w-auto shrink-0" />
      }
      title="FrameOS Cloud"
      greetingName={greetingName}
    />
  )
}

function BackendHomeHeader(): JSX.Element {
  const { theme } = useValues(workspaceLogic)
  const { greetingName } = useValues(backendHomeLogic)
  return (
    <HomeHeader
      logo={
        <FrameosLogo alt="" variant={theme === 'dark' ? 'white-colors' : 'color'} className="h-14 w-auto shrink-0" />
      }
      title="FrameOS"
      greetingName={greetingName}
    />
  )
}

// A backend's own saved scenes ("Save to My scenes", uploaded zips). They
// have no page of their own, so a tile opens the library page that lists them.
function LocalScenesSection(): JSX.Element {
  const { templates, templatesLoading, recentLocalScenes } = useValues(backendHomeLogic)
  return (
    <Section title={scenesLibraryPageLabel('local')} count={templates.length} seeAllHref={urls.scenesHome('local')}>
      {templatesLoading && templates.length === 0 ? (
        <Loading>Loading saved scenes…</Loading>
      ) : recentLocalScenes.length === 0 ? (
        <Empty icon={<RectangleGroupIcon />}>
          No saved scenes yet. Use Save to "My scenes" on any scene, or{' '}
          <A href={urls.scenesHome('local')} className="font-semibold underline-offset-2 hover:underline">
            upload a zip
          </A>
          .
        </Empty>
      ) : (
        <OneRowGrid>
          {recentLocalScenes.map((template) => (
            <SceneTile
              key={template.id ?? template.name}
              template={template}
              showAuthor={false}
              appHref={urls.scenesHome('local')}
            />
          ))}
        </OneRowGrid>
      )}
    </Section>
  )
}

function CloudUsageSection(): JSX.Element {
  const { usage, usageResponseLoading } = useValues(cloudHomeLogic)
  return (
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
  )
}

// Where the cloud shows the account's quotas: the fleet, the scenes on it,
// the photo library on its disk and the release this backend runs.
function BackendGlanceSection(): JSX.Element {
  const { glance, photosStatus } = useValues(backendHomeLogic)
  const { framesEverLoaded } = useValues(homeLogic)
  return (
    <Section title="At a glance" count={0}>
      {!framesEverLoaded ? (
        <Loading>Loading…</Loading>
      ) : (
        <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
          <Stat label="Frames" value={`${glance.frames}`} detail={`${glance.activeFrames} active`} />
          <Stat
            label="Installed scenes"
            value={`${glance.installedScenes}`}
            detail={`on ${glance.framesWithScenes} ${glance.framesWithScenes === 1 ? 'frame' : 'frames'}`}
          />
          {photosStatus ? (
            <Stat
              label="Photos"
              value={formatBytes(photosStatus.used_bytes)}
              detail={photosStatus.free_bytes !== null ? `${formatBytes(photosStatus.free_bytes)} free` : undefined}
            />
          ) : null}
          {backendVersion ? <Stat label="Version" value={backendVersion} detail="FrameOS on this backend" /> : null}
        </div>
      )}
    </Section>
  )
}

export function Home(): JSX.Element {
  const cloud = isCloudMode()
  const {
    recentFrames,
    framesList,
    framesEverLoaded,
    recentAlbums,
    albums,
    albumsLoading,
    albumsFailed,
    storeTemplates,
    recentStoreScenes,
    repositoriesLoading,
    driveTemplates,
    recentPrivateScenes,
    driveTemplatesLoading,
    hasDriveScope,
  } = useValues(homeLogic)

  return (
    <FrameosShell mode="home" title="Home" browserTitle="Home" tree={null} topBar={null} showAiButton={false}>
      <div className="mx-auto max-w-6xl space-y-10 pb-16 pt-6 @container">
        {cloud ? <CloudHomeHeader /> : <BackendHomeHeader />}

        <Section title="Frames" count={framesList.length} seeAllHref={urls.frames()}>
          {!framesEverLoaded ? (
            <Loading>Loading frames…</Loading>
          ) : recentFrames.length === 0 ? (
            <Empty icon={<ComputerDesktopIcon />}>
              No frames yet.{' '}
              <A href={urls.frames()} className="font-semibold underline-offset-2 hover:underline">
                Add your first frame
              </A>
              .
            </Empty>
          ) : (
            <OneRowGrid>
              {recentFrames.map((frame) => (
                <FrameTile key={frame.id} frame={frame} />
              ))}
            </OneRowGrid>
          )}
        </Section>

        <Section
          title="Latest additions to the public scene store"
          count={storeTemplates.length}
          seeAllHref={urls.scenesHome('store')}
        >
          {repositoriesLoading && storeTemplates.length === 0 ? (
            <Loading>Loading the scene store…</Loading>
          ) : recentStoreScenes.length === 0 ? (
            <Empty icon={<RectangleGroupIcon />}>The scene store is not available right now.</Empty>
          ) : (
            <OneRowGrid>
              {recentStoreScenes.map((template) => (
                <SceneTile key={template.sceneId ?? template.id ?? template.name} template={template} />
              ))}
            </OneRowGrid>
          )}
        </Section>

        {!cloud ? <LocalScenesSection /> : null}

        {/* A backend has cloud scenes once it is linked with the private
            scenes feature; the library's page says how to turn it on. */}
        {cloud || hasDriveScope ? (
          <Section
            title={scenesLibraryPageLabel('cloud')}
            count={driveTemplates.length}
            seeAllHref={urls.scenesHome('cloud')}
          >
            {driveTemplatesLoading && driveTemplates.length === 0 ? (
              <Loading>Loading your scenes…</Loading>
            ) : recentPrivateScenes.length === 0 ? (
              <Empty icon={<RectangleGroupIcon />}>
                {cloud ? (
                  <>
                    No private scenes yet.{' '}
                    <A href={urls.scenesHome('cloud')} className="font-semibold underline-offset-2 hover:underline">
                      Make one
                    </A>
                    .
                  </>
                ) : (
                  'No scenes in your cloud yet. Use "Save to cloud (private)" on any scene to add one.'
                )}
              </Empty>
            ) : (
              <OneRowGrid>
                {recentPrivateScenes.map((template) => (
                  <SceneTile
                    key={template.sceneId ?? template.id ?? template.name}
                    template={template}
                    showAuthor={false}
                  />
                ))}
              </OneRowGrid>
            )}
          </Section>
        ) : null}

        {photosLibraryIsAvailable() ? (
          <Section title="Photos" count={albums.length} seeAllHref={urls.photos()}>
            {albumsLoading && albums.length === 0 ? (
              <Loading>Loading albums…</Loading>
            ) : albumsFailed ? (
              <Empty icon={<FolderIcon />}>
                Photos are not available right now.{' '}
                <A href={urls.photos()} className="font-semibold underline-offset-2 hover:underline">
                  Open Photos
                </A>{' '}
                to see why.
              </Empty>
            ) : recentAlbums.length === 0 ? (
              <Empty icon={<FolderIcon />}>
                No albums yet.{' '}
                <A href={urls.photos()} className="font-semibold underline-offset-2 hover:underline">
                  Make one in Photos
                </A>
                .
              </Empty>
            ) : (
              <OneRowGrid>
                {recentAlbums.map((album) => (
                  <AlbumTile key={album.path} album={album} />
                ))}
              </OneRowGrid>
            )}
          </Section>
        ) : null}

        {cloud ? <CloudUsageSection /> : <BackendGlanceSection />}
      </div>
    </FrameosShell>
  )
}

export default Home
