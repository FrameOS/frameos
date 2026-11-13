import clsx from 'clsx'
import Editor from '@monaco-editor/react'
import { useActions, useValues } from 'kea'
import type { ReactNode } from 'react'

import { Select } from '../components/Select'
import { TextArea } from '../components/TextArea'
import { TextInput } from '../components/TextInput'
import { configureAppSourceEditor } from '../scenes/frame/panels/EditApp/EditApp'
import { workspaceLogic } from '../scenes/workspace/workspaceLogic'
import { inmemoryModelPath } from '../utils/monacoPaths'
import { templateChangesFromJson, templateJsonText, type SceneTemplateMetadata } from './sceneFiles'
import { sceneFileTreeLogic } from './sceneFileTreeLogic'
import type { FrameId } from '../types'

/** A field of template.json a host keeps. */
export type TemplateField = 'name' | 'description' | 'category' | 'frameosVersion' | 'tags'

/** The store's: everything but the name, which its scene page renames. */
export const STORE_TEMPLATE_FIELDS: TemplateField[] = ['description', 'category', 'frameosVersion', 'tags']

export interface TemplateCategoryOption {
  value: string
  label: string
}

interface TemplateFileProps {
  frameId: FrameId
  template: SceneTemplateMetadata
  /** Absent: the template is shown read only (a visitor's playground). */
  onChange?: (changes: Partial<SceneTemplateMetadata>) => void
  categories?: TemplateCategoryOption[]
  sceneCount: number
  /** What the Form view shows instead of the built-in form: the host's own
   * view of the template (the store's scene page — gallery, description,
   * versions, listing). The Source view is template.json either way. */
  content?: ReactNode
  /** The fields the form edits; the others are left out of it (the name is
   * shown read only). The store's by default. */
  fields?: TemplateField[]
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="frameos-strong block text-sm font-semibold">{label}</span>
      {children}
      {hint ? <span className="frameos-muted block text-xs">{hint}</span> : null}
    </label>
  )
}

function tagsFromText(text: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const part of text.split(',')) {
    const tag = part.trim()
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase())
      tags.push(tag)
    }
  }
  return tags
}

// template.json as a file: the template's listing (what a store page and a
// zip's manifest say about the scenes), apart from the scenes themselves.
// A form by default, like an app's config.json; its JSON one click away.
export function TemplateFile({
  frameId,
  template,
  onChange,
  categories,
  sceneCount,
  content,
  fields = STORE_TEMPLATE_FIELDS,
}: TemplateFileProps): JSX.Element {
  const { templateSourceView, templateSourceError } = useValues(sceneFileTreeLogic({ frameId }))
  const { setTemplateSourceView, setTemplateSourceError } = useActions(sceneFileTreeLogic({ frameId }))
  const { theme } = useValues(workspaceLogic)
  const readOnly = !onChange
  const categoryOptions = [
    { value: '', label: 'No category' },
    ...(categories ?? []),
    // A category the host's list does not know (a retired one) still shows.
    ...(template.category && !(categories ?? []).some((option) => option.value === template.category)
      ? [{ value: template.category, label: template.category }]
      : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 @container">
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <div className="frameos-muted min-w-0 flex-1 truncate">
          {templateSourceView
            ? 'template.json'
            : `What the store and the zip say about ${sceneCount === 1 ? 'the scene' : `these ${sceneCount} scenes`}.`}
        </div>
        <div className="frameos-inset flex rounded-lg border p-0.5" role="group" aria-label="Edit template.json as">
          {[
            { label: 'Form', source: false },
            { label: 'Source', source: true },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={templateSourceView === option.source}
              onClick={() => setTemplateSourceView(option.source)}
              className={clsx(
                'rounded-md px-2.5 py-1 font-semibold transition',
                templateSourceView === option.source ? 'frameos-primary-action text-white' : 'frameos-muted'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {readOnly && (templateSourceView || !content) ? (
        <div className="frameos-muted shrink-0 rounded-lg border border-dashed px-3 py-2 text-xs">
          Read only: only the template's owner edits its listing.
        </div>
      ) : null}
      {templateSourceView ? (
        <>
          <div className="frameos-inset min-h-0 flex-1 overflow-hidden rounded-md border font-mono text-sm">
            <Editor
              height="100%"
              path={inmemoryModelPath('scene-template', [String(frameId)], 'template.json')}
              language="json"
              // Rebuilt from the listing while it is valid, so the form and
              // the source never disagree.
              value={templateJsonText(template)}
              theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
              beforeMount={configureAppSourceEditor}
              onChange={(value) => {
                if (!onChange) {
                  return
                }
                const result = templateChangesFromJson(value ?? '', template)
                if ('error' in result) {
                  setTemplateSourceError(result.error)
                } else {
                  setTemplateSourceError(null)
                  if (Object.keys(result.changes).length > 0) {
                    onChange(result.changes)
                  }
                }
              }}
              options={{ minimap: { enabled: false }, readOnly, domReadOnly: readOnly }}
            />
          </div>
          {templateSourceError ? (
            <div className="shrink-0 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">
              {templateSourceError}
            </div>
          ) : null}
        </>
      ) : content ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="frame-tool-card max-w-2xl space-y-4 rounded-2xl p-4">
            {fields.includes('name') ? (
              <Field label="Name">
                <TextInput
                  value={template.name}
                  disabled={readOnly}
                  onChange={(value) => onChange?.({ name: value })}
                />
              </Field>
            ) : (
              <Field label="Name" hint="The name the store lists the template under.">
                <TextInput value={template.name} disabled readOnly />
              </Field>
            )}
            <Field
              label="Description"
              hint={
                fields.includes('category')
                  ? 'Markdown. Shown on the store page and in the install dialog.'
                  : 'Shown with the scene in the list.'
              }
            >
              <TextArea
                value={template.description ?? ''}
                rows={8}
                disabled={readOnly}
                placeholder="What the scene shows, what it needs (an API key, a frame size)…"
                onChange={(value) => onChange?.({ description: value === '' ? null : value })}
              />
            </Field>
            {fields.includes('category') || fields.includes('frameosVersion') ? (
              <div className="grid gap-4 @2xl:grid-cols-2">
                {fields.includes('category') ? (
                  <Field label="Category">
                    <Select
                      value={template.category ?? ''}
                      disabled={readOnly}
                      options={categoryOptions}
                      onChange={(value) => onChange?.({ category: value || null })}
                    />
                  </Field>
                ) : null}
                {fields.includes('frameosVersion') ? (
                  <Field label="Minimum FrameOS version" hint="The oldest FrameOS that runs these scenes.">
                    <TextInput
                      value={template.frameosVersion ?? ''}
                      disabled={readOnly}
                      placeholder="e.g. 2026.11.3"
                      onChange={(value) => onChange?.({ frameosVersion: value.trim() || null })}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
            {fields.includes('tags') ? (
              <Field label="Tags" hint="Separated by commas.">
                <TextInput
                  // Uncontrolled while typing (a trailing comma must survive a
                  // keystroke); committed on blur, and reset when the tags
                  // change elsewhere (the Info column, the AI).
                  key={template.tags.join(',')}
                  defaultValue={template.tags.join(', ')}
                  disabled={readOnly}
                  placeholder="clock, weather, photos"
                  onBlur={(event) => {
                    const next = tagsFromText(event.currentTarget.value)
                    if (next.join(',') !== template.tags.join(',')) {
                      onChange?.({ tags: next })
                    }
                  }}
                />
              </Field>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
