import { useActions, useValues } from 'kea'
import { A, router } from 'kea-router'
import clsx from 'clsx'
import { CloudIcon, RectangleGroupIcon } from '@heroicons/react/24/outline'

import { FrameImage } from '../../components/FrameImage'
import { Spinner } from '../../components/Spinner'
import { Tag } from '../../components/Tag'
import { useEntityImage } from '../../models/entityImagesModel'
import { framesModel } from '../../models/framesModel'
import { repositoriesModel } from '../../models/repositoriesModel'
import { templatesModel } from '../../models/templatesModel'
import type { FrameScene, FrameType, TemplateType } from '../../types'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import { cloudDriveLogic } from '../frame/panels/Templates/cloudDriveLogic'
import { cloudLogic } from '../settings/cloudLogic'
import { FrameosShell } from './FrameosShell'
import { WorkspaceSceneDropDown } from './WorkspaceSceneDropDown'
import { workspaceLogic } from './workspaceLogic'

/** The /scenes overview: every frame's scenes at a glance, followed by the
 * account-level scene sources (cloud drive, local templates, repositories).
 * Read-mostly — editing happens in the per-frame scene workspace, installing
 * in a frame's Templates drawer. */
export default function ScenesOverview(): JSX.Element {
  const { activeFramesList, framesLoading } = useValues(framesModel)
  const { search } = useValues(workspaceLogic)

  const query = search.trim().toLowerCase()

  return (
    <FrameosShell
      mode="scenes"
      title="Scenes"
      browserTitle="Scenes"
      tree={<ScenesOverviewTree frames={activeFramesList} />}
      showAiButton={false}
    >
      <div className="space-y-10 pb-10">
        <div>
          <h1 className="frameos-strong text-3xl font-bold tracking-tight">Scenes</h1>
          <p className="frameos-muted mt-1 text-sm">
            Everything in one place: the scenes on your frames, your cloud drive, saved scenes, and repositories.
          </p>
        </div>
        {framesLoading && activeFramesList.length === 0 ? (
          <Spinner />
        ) : (
          activeFramesList.map((frame) => <FrameScenesSection key={frame.id} frame={frame} query={query} />)
        )}
        {!framesLoading && activeFramesList.length === 0 ? (
          <div className="frameos-muted text-sm">No frames yet — add one from the frames home.</div>
        ) : null}
        <CloudDriveSection query={query} />
        <LocalTemplatesSection query={query} />
        <RepositoriesSection query={query} />
      </div>
    </FrameosShell>
  )
}

function ScenesOverviewTree({ frames }: { frames: FrameType[] }): JSX.Element {
  return (
    <nav className="space-y-1">
      {frames.map((frame) => (
        <A
          key={frame.id}
          href={urls.scenes(frame.id)}
          className="frameos-tree-row flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          <RectangleGroupIcon className="h-5 w-5 shrink-0 text-slate-400" />
          <span className="truncate">{frame.name || frameHost(frame)}</span>
          <span className="frameos-muted ml-auto text-xs">{frame.scenes?.length ?? 0}</span>
        </A>
      ))}
    </nav>
  )
}

function matchesQuery(query: string, ...parts: (string | undefined | null)[]): boolean {
  return query === '' || parts.some((part) => part?.toLowerCase().includes(query))
}

function SectionHeading({
  title,
  count,
  subtitle,
}: {
  title: React.ReactNode
  count?: number
  subtitle?: React.ReactNode
}): JSX.Element {
  return (
    <div className="mb-3">
      <h2 className="frameos-strong flex items-baseline gap-2 text-xl font-bold tracking-tight">
        {title}
        {typeof count === 'number' ? <span className="frameos-muted text-sm font-medium">{count}</span> : null}
      </h2>
      {subtitle ? <div className="frameos-muted mt-0.5 text-sm">{subtitle}</div> : null}
    </div>
  )
}

function FrameScenesSection({ frame, query }: { frame: FrameType; query: string }): JSX.Element | null {
  const scenes = [...(frame.scenes ?? [])]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .filter((scene) => matchesQuery(query, scene.name, scene.id))

  if (query !== '' && scenes.length === 0) {
    return null
  }

  return (
    <section>
      <SectionHeading
        title={<A href={urls.scenes(frame.id)}>{frame.name || frameHost(frame)}</A>}
        count={frame.scenes?.length ?? 0}
      />
      {scenes.length === 0 ? (
        <div className="frameos-muted text-sm">This frame has no scenes.</div>
      ) : (
        <div className="flex flex-wrap gap-4">
          {scenes.map((scene) => (
            <OverviewSceneTile key={scene.id} frame={frame} scene={scene} scenes={frame.scenes ?? []} />
          ))}
        </div>
      )}
    </section>
  )
}

function OverviewSceneTile({
  frame,
  scene,
  scenes,
}: {
  frame: FrameType
  scene: FrameScene
  scenes: FrameScene[]
}): JSX.Element {
  const active = frame.active_scene_id === scene.id

  return (
    <div className="frameos-card group relative z-[1] h-36 w-36 shrink-0 overflow-hidden rounded-lg border border-white/90 bg-white text-left shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50 focus-within:ring-2 focus-within:ring-blue-400">
      <button
        type="button"
        onClick={() => router.actions.push(urls.scenes(frame.id, scene.id))}
        className="flex h-full w-full flex-col"
        title={`Edit "${scene.name || scene.id}" on ${frame.name || frameHost(frame)}`}
      >
        <div className="frameos-card-media relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
          <FrameImage
            frameId={frame.id}
            sceneId={scene.id}
            thumb
            refreshable={false}
            objectFit="cover"
            className="h-full w-full rounded-none"
          />
        </div>
        <div className="w-full px-3 py-2">
          <div className="frameos-strong truncate text-sm font-semibold text-slate-900">
            {scene.name || 'Untitled scene'}
          </div>
        </div>
      </button>
      {active ? (
        <div className="pointer-events-none absolute left-1 top-1 z-10">
          <div className="frameos-primary-fill rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
            Active
          </div>
        </div>
      ) : null}
      <WorkspaceSceneDropDown
        frame={frame}
        scene={scene}
        scenes={scenes}
        horizontal
        buttonColor="none"
        className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white/70 !px-0 !py-0 text-slate-500/80 shadow-sm backdrop-blur-sm transition hover:bg-white/95 hover:text-slate-700"
      />
    </div>
  )
}

/** A read-only card for a template from the cloud drive, local storage, or a
 * repository. Installing needs a target frame, so cards link out (cloud store
 * page) or point people at a frame's Templates drawer. */
function TemplateCard({ template, local }: { template: TemplateType; local?: boolean }): JSX.Element {
  // Locally saved templates serve their image behind a signed entity URL;
  // repository and cloud drive entries carry a plain URL (see cloudDriveLogic).
  const { imageUrl: localImageUrl } = useEntityImage(
    local && template.id ? `templates/${template.id}` : null,
    'image'
  )
  const imageUrl = localImageUrl ?? (typeof template.image === 'string' ? template.image : null)
  const body = (
    <>
      <div className="frameos-card-media relative flex min-h-0 flex-1 items-center justify-center bg-slate-100">
        {imageUrl ? (
          <img src={imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="frameos-muted text-xs">No preview</div>
        )}
      </div>
      <div className="w-full px-3 py-2">
        <div className="frameos-strong flex items-center gap-1 truncate text-sm font-semibold text-slate-900">
          <span className="truncate">{template.name}</span>
          {template.visibility === 'private' ? (
            <Tag color="gray" className="shrink-0 normal-case">
              private
            </Tag>
          ) : null}
          {template.flags?.includes('shell') ? (
            <Tag
              color="red"
              className="shrink-0 normal-case"
              title="This scene configures apps or custom code that run shell commands on the frame"
            >
              shell
            </Tag>
          ) : null}
        </div>
        {template.author || template.frameosVersion ? (
          <div className="frameos-muted mt-0.5 truncate text-xs text-slate-500">
            {template.author ? `by ${template.author}` : ''}
            {template.author && template.frameosVersion ? ' · ' : ''}
            {template.frameosVersion ? `FrameOS ${template.frameosVersion}` : ''}
          </div>
        ) : null}
      </div>
    </>
  )

  const className =
    'frameos-card group relative z-[1] flex h-36 w-36 shrink-0 flex-col overflow-hidden rounded-lg border border-white/90 bg-white text-left shadow-lg shadow-slate-300/35 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-300/50'

  if (template.url) {
    return (
      <a
        href={template.url}
        target="_blank"
        rel="noreferrer noopener"
        className={className}
        title="Open on FrameOS Cloud"
      >
        {body}
      </a>
    )
  }
  return (
    <div className={clsx(className, 'cursor-default')} title="Open a frame's Templates drawer to install this scene">
      {body}
    </div>
  )
}

function TemplateCardGrid({ templates, local }: { templates: TemplateType[]; local?: boolean }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-4">
      {templates.map((template, index) => (
        <TemplateCard key={template.id ?? template.sceneId ?? -index} template={template} local={local} />
      ))}
    </div>
  )
}

function filterTemplates(templates: TemplateType[], query: string): TemplateType[] {
  return [...templates]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((template) => matchesQuery(query, template.name, template.author, template.description))
}

function CloudDriveSection({ query }: { query: string }): JSX.Element | null {
  const { driveTemplates, driveTemplatesLoading, hasDriveScope } = useValues(cloudDriveLogic)
  const { cloudProviderUrl } = useValues(cloudLogic)

  const templates = filterTemplates(driveTemplates, query)
  if (query !== '' && templates.length === 0) {
    return null
  }

  return (
    <section>
      <SectionHeading
        title={
          <span className="flex items-center gap-2">
            <CloudIcon className="h-5 w-5 text-slate-400" />
            My cloud drive
          </span>
        }
        count={hasDriveScope ? driveTemplates.length : undefined}
      />
      {!hasDriveScope ? (
        <div className="frameos-muted text-sm">
          Save scenes to your private cloud drive and access them from every FrameOS install. Connect FrameOS Cloud
          under <A href={urls.settings()}>Settings</A>.
        </div>
      ) : driveTemplatesLoading && driveTemplates.length === 0 ? (
        <Spinner />
      ) : templates.length === 0 ? (
        <div className="frameos-muted text-sm">
          Your cloud drive is empty. Use “Save to cloud drive” in any scene menu.
        </div>
      ) : (
        <TemplateCardGrid templates={templates} />
      )}
      {hasDriveScope && cloudProviderUrl ? (
        <div className="frameos-muted mt-2 text-xs">
          Manage your published scenes on{' '}
          <a className="underline" href={cloudProviderUrl} target="_blank" rel="noreferrer noopener">
            FrameOS Cloud
          </a>
          .
        </div>
      ) : null}
    </section>
  )
}

function LocalTemplatesSection({ query }: { query: string }): JSX.Element | null {
  const { templates } = useValues(templatesModel)
  const filtered = filterTemplates(templates, query)
  if (query !== '' && filtered.length === 0) {
    return null
  }

  return (
    <section>
      <SectionHeading
        title="My local scenes"
        count={templates.length}
        subtitle="Saved on this FrameOS install. Install them from a frame's Templates drawer."
      />
      {filtered.length === 0 ? (
        <div className="frameos-muted text-sm">You have no saved scenes.</div>
      ) : (
        <TemplateCardGrid templates={filtered} local />
      )}
    </section>
  )
}

function RepositoriesSection({ query }: { query: string }): JSX.Element {
  const { repositories } = useValues(repositoriesModel)
  const { refreshRepository } = useActions(repositoriesModel)

  return (
    <>
      {(repositories ?? []).map((repository) => {
        const templates = filterTemplates(repository.templates ?? [], query)
        if (query !== '' && templates.length === 0) {
          return null
        }
        return (
          <section key={repository.id ?? repository.url}>
            <SectionHeading
              title={repository.name || repository.url}
              count={repository.templates?.length ?? 0}
              subtitle={repository.description}
            />
            {templates.length === 0 ? (
              <div className="frameos-muted text-sm">
                This repository has no scenes.{' '}
                {repository.id ? (
                  <button type="button" className="underline" onClick={() => refreshRepository(repository.id!)}>
                    Refresh
                  </button>
                ) : null}
              </div>
            ) : (
              <TemplateCardGrid templates={templates} />
            )}
          </section>
        )
      })}
    </>
  )
}
