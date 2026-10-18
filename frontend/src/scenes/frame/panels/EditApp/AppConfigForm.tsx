import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'

import { AdvancedSection } from '../../../../components/AdvancedSection'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { Switch } from '../../../../components/Switch'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import {
  appConfigFieldTypes,
  fieldTypes,
  type AppConfigField,
  type AppConfigFieldType,
  type FieldType,
  type MarkdownField,
  type OutputField,
} from '../../../../types'
import { booleanFieldValue } from '../../../../utils/booleanField'
import { fieldValueText, isMarkdownEntry, type AppConfigEntry } from '../../../../utils/appConfigForm'
import { selectFieldOptions, selectOptionsFromText, selectOptionsToText } from '../../../../utils/selectOptions'
import { settingsDetails } from '../secretSettings'
import { ShowIfEditor, type ShowIfConditions } from '../Fields/ShowIfEditor'
import { appConfigFormLogic } from './appConfigFormLogic'
import type { EditAppLogicProps } from './editAppLogic'

const FIELD_TYPE_LABELS: Record<AppConfigFieldType, string> = {
  string: 'Text, one line',
  text: 'Text, several lines',
  float: 'Number',
  integer: 'Whole number',
  boolean: 'On or off',
  select: 'Choice from a list',
  color: 'Color',
  date: 'Date',
  json: 'JSON',
  node: 'Node (connect another node)',
  scene: 'Scene',
  image: 'Image',
  font: 'Font',
  path: 'File or folder on the frame',
}

const OUTPUT_TYPE_LABELS: Partial<Record<FieldType, string>> = {
  image: 'Image',
  string: 'Text',
  text: 'Text, several lines',
  json: 'JSON',
  float: 'Number',
  integer: 'Whole number',
  boolean: 'On or off',
}

const CATEGORIES = [
  { value: 'data', label: 'Data' },
  { value: 'render', label: 'Render' },
  { value: 'logic', label: 'Logic' },
]

const PERMISSION_LABELS: Record<string, string> = {
  shell: 'Run shell commands',
  files: 'Read any file',
  assets: 'Read the assets folder',
  'assets-write': 'Write to the assets folder',
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="frame-tool-card space-y-3 rounded-2xl p-4">
      <div>
        <h3 className="frameos-strong text-sm font-semibold">{title}</h3>
        {description ? <p className="frameos-muted mt-0.5 text-xs">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  hint,
  compound,
  children,
}: {
  label: string
  hint?: ReactNode
  /** Holds several controls (or a switch with its own label): not a <label>. */
  compound?: boolean
  children: ReactNode
}): JSX.Element {
  const Tag = compound ? 'div' : 'label'
  return (
    <Tag className="block min-w-0 space-y-1">
      <span className="frameos-muted block text-xs font-semibold">{label}</span>
      {children}
      {hint ? <span className="frameos-muted block text-xs">{hint}</span> : null}
    </Tag>
  )
}

function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.replace(/^\.+/, '').trim())
    .filter(Boolean)
}

/** A comma separated list, applied when the input loses focus or on Enter, so a
 * half typed "jpg," keeps its comma. */
function ListInput({
  value,
  placeholder,
  onChange,
}: {
  value: string[]
  placeholder?: string
  onChange: (value: string[]) => void
}): JSX.Element {
  const text = value.join(', ')
  return (
    <TextInput
      key={text}
      defaultValue={text}
      {...(placeholder ? { placeholder } : {})}
      onBlur={(event) => {
        const next = splitList(event.target.value)
        if (next.join(', ') !== text) {
          onChange(next)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function IconButton({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={clsx(
        'frameos-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-30',
        danger && 'text-red-500'
      )}
    >
      {children}
    </button>
  )
}

/** A select field's choices, one per line, applied when the box loses focus:
 * parsing on every key would drop the new line being typed. */
function ChoicesInput({
  options,
  onChange,
}: {
  options: AppConfigField['options']
  onChange: (options: AppConfigField['options']) => void
}): JSX.Element {
  const text = selectOptionsToText(options)
  return (
    <TextArea
      key={text}
      rows={4}
      defaultValue={text}
      onBlur={(event) => {
        const next = selectOptionsFromText(event.target.value)
        if (selectOptionsToText(next) !== text) {
          onChange(next)
        }
      }}
    />
  )
}

/** "1" and "3" are numbers in a seq range; anything else names a field. */
function seqBound(text: string): string | number {
  const trimmed = text.trim()
  return trimmed !== '' && /^-?\d+$/.test(trimmed) ? parseInt(trimmed) : trimmed
}

function DefaultValueInput({ field, onChange }: { field: AppConfigField; onChange: (value: unknown) => void }) {
  const text = fieldValueText(field.value)
  if (field.type === 'boolean') {
    return (
      <Switch
        aria-label="On by default"
        label="On by default"
        value={booleanFieldValue(field.value)}
        onChange={(on) => onChange(on ? 'true' : 'false')}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <Select
        value={text}
        onChange={(value) => onChange(value)}
        options={[{ value: '', label: 'Nothing selected' }, ...selectFieldOptions(field.options)]}
      />
    )
  }
  if (field.type === 'text' || field.type === 'json') {
    return <TextArea rows={3} value={text} onChange={(value) => onChange(value)} className="font-mono" />
  }
  return (
    <TextInput
      value={text}
      {...(field.type === 'color' ? { placeholder: '#000000' } : {})}
      onChange={(value) => onChange(value)}
    />
  )
}

function FieldEditor({
  logicProps,
  field,
  index,
  siblings,
}: {
  logicProps: EditAppLogicProps
  field: AppConfigField
  index: number
  siblings: AppConfigField[]
}): JSX.Element {
  const { updateEntry, renameField, removeEntry, toggleEntry } = useActions(appConfigFormLogic(logicProps))
  const update = (patch: Record<string, unknown>): void => updateEntry(index, patch)
  const seq = field.seq ?? []
  const setSeq = (next: AppConfigField['seq']): void => update({ seq: next && next.length ? next : undefined })
  const typeOptions = appConfigFieldTypes.map((type) => ({ value: type, label: FIELD_TYPE_LABELS[type] ?? type }))
  return (
    <div className="space-y-3 px-3 pb-3 pt-1">
      <div className="grid gap-3 @md:grid-cols-2">
        <Row label="Codename" hint={`How the app's code reads it: app.config.${field.name || 'name'}`}>
          <TextInput value={field.name} placeholder="e.g. searchTerm" onChange={(name) => renameField(index, name)} />
        </Row>
        <Row label="Label">
          <TextInput value={field.label ?? ''} onChange={(label) => update({ label })} />
        </Row>
        <Row label="Type">
          <Select value={field.type} options={typeOptions} onChange={(type) => update({ type })} />
        </Row>
        <Row label="Default value" compound={field.type === 'boolean'}>
          <DefaultValueInput field={field} onChange={(value) => update({ value })} />
        </Row>
      </div>
      {field.type === 'select' ? (
        <Row label="Choices" hint='One per line. Write "value | Label" to show a different label.'>
          <ChoicesInput options={field.options} onChange={(options) => update({ options })} />
        </Row>
      ) : null}
      {field.type === 'path' ? (
        <div className="grid gap-3 @md:grid-cols-2">
          <Row label="Points at">
            <Select
              value={field.pick ?? 'file'}
              options={[
                { value: 'file', label: 'A file' },
                { value: 'folder', label: 'A folder' },
                { value: 'any', label: 'A file or a folder' },
              ]}
              onChange={(pick) => update({ pick: pick === 'file' ? undefined : pick })}
            />
          </Row>
          <Row label="Allowed file extensions" hint="Comma separated, no dots. Empty allows any file.">
            <ListInput
              value={field.extensions ?? []}
              placeholder="jpg, png"
              onChange={(extensions) => update({ extensions: extensions.length ? extensions : undefined })}
            />
          </Row>
        </div>
      ) : null}
      <div className="grid gap-3 @md:grid-cols-2">
        {field.type !== 'boolean' && field.type !== 'select' ? (
          <Row label="Placeholder">
            <TextInput
              value={field.placeholder ?? ''}
              onChange={(placeholder) => update({ placeholder: placeholder || undefined })}
            />
          </Row>
        ) : null}
        {field.type === 'text' ? (
          <Row label="Rows">
            <TextInput
              type="number"
              min={1}
              value={field.rows === undefined ? '' : String(field.rows)}
              placeholder="3"
              onChange={(rows) => update({ rows: rows ? Math.max(1, parseInt(rows) || 1) : undefined })}
            />
          </Row>
        ) : null}
      </div>
      <Row label="Help text" hint="Markdown, shown behind the field's info icon.">
        <TextArea rows={2} value={field.hint ?? ''} onChange={(hint) => update({ hint: hint || undefined })} />
      </Row>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Switch
          label="Required"
          value={!!field.required}
          onChange={(required) => update({ required: required || undefined })}
        />
        <Switch
          label="Secret, hidden like a password"
          value={!!field.secret}
          onChange={(secret) => update({ secret: secret || undefined })}
        />
      </div>
      <Row label="Show only if" compound>
        <ShowIfEditor
          value={field.showIf as ShowIfConditions | undefined}
          availableFields={siblings}
          onChange={(showIf) => update({ showIf: showIf && showIf.length ? showIf : undefined })}
        />
      </Row>
      <AdvancedSection label="Repeat this field" open={seq.length > 0}>
        <p className="frameos-muted text-xs">
          Shows the field once per number in a range, e.g. "color" from 1 to a field named "colorCount". Put{' '}
          <code>{'{color}'}</code> in the label to number each copy.
        </p>
        {seq.map(([name, start, end], seqIndex) => (
          <div key={seqIndex} className="flex items-end gap-2">
            <Row label="Name">
              <TextInput
                value={name}
                onChange={(value) =>
                  setSeq(seq.map((row, i) => (i === seqIndex ? [value, row[1], row[2]] : row)) as AppConfigField['seq'])
                }
              />
            </Row>
            <Row label="From">
              <TextInput
                value={String(start)}
                onChange={(value) =>
                  setSeq(
                    seq.map((row, i) =>
                      i === seqIndex ? [row[0], seqBound(value), row[2]] : row
                    ) as AppConfigField['seq']
                  )
                }
              />
            </Row>
            <Row label="To (a number or a field)">
              <TextInput
                value={String(end)}
                onChange={(value) =>
                  setSeq(
                    seq.map((row, i) =>
                      i === seqIndex ? [row[0], row[1], seqBound(value)] : row
                    ) as AppConfigField['seq']
                  )
                }
              />
            </Row>
            <IconButton title="Remove" danger onClick={() => setSeq(seq.filter((_, i) => i !== seqIndex))}>
              <TrashIcon className="h-4 w-4" />
            </IconButton>
          </div>
        ))}
        <Button size="small" color="secondary" onClick={() => setSeq([...seq, ['index', 1, 3]])}>
          Add a range
        </Button>
      </AdvancedSection>
      <div className="flex justify-between gap-2 pt-1">
        <Button size="small" color="secondary" onClick={() => toggleEntry(index)}>
          Close
        </Button>
        <Button size="small" color="secondary" onClick={() => removeEntry(index)}>
          <span className="text-red-500">Remove field</span>
        </Button>
      </div>
    </div>
  )
}

function MarkdownEditor({
  logicProps,
  entry,
  index,
  siblings,
}: {
  logicProps: EditAppLogicProps
  entry: MarkdownField
  index: number
  siblings: AppConfigField[]
}): JSX.Element {
  const { updateEntry, removeEntry, toggleEntry } = useActions(appConfigFormLogic(logicProps))
  return (
    <div className="space-y-3 px-3 pb-3 pt-1">
      <Row label="Text" hint="Markdown, shown between the fields.">
        <TextArea rows={3} value={entry.markdown} onChange={(markdown) => updateEntry(index, { markdown })} />
      </Row>
      <Row label="Show only if" compound>
        <ShowIfEditor
          value={entry.showIf as ShowIfConditions | undefined}
          availableFields={siblings}
          onChange={(showIf) => updateEntry(index, { showIf: showIf && showIf.length ? showIf : undefined })}
        />
      </Row>
      <div className="flex justify-between gap-2 pt-1">
        <Button size="small" color="secondary" onClick={() => toggleEntry(index)}>
          Close
        </Button>
        <Button size="small" color="secondary" onClick={() => removeEntry(index)}>
          <span className="text-red-500">Remove text</span>
        </Button>
      </div>
    </div>
  )
}

function entrySummary(entry: AppConfigEntry): { title: string; detail: string; tags: string[] } {
  if (isMarkdownEntry(entry)) {
    const firstLine = entry.markdown.split('\n').find((line) => line.trim()) ?? ''
    return {
      title: firstLine || 'Empty text',
      detail: 'Text between the fields',
      tags: entry.showIf ? ['conditional'] : [],
    }
  }
  return {
    title: entry.label || entry.name || 'Unnamed field',
    detail: `${entry.name || '?'} · ${FIELD_TYPE_LABELS[entry.type] ?? entry.type}`,
    tags: [
      entry.required ? 'required' : null,
      entry.secret ? 'secret' : null,
      entry.showIf?.length ? 'conditional' : null,
      entry.seq?.length ? 'repeated' : null,
    ].filter((tag): tag is string => !!tag),
  }
}

function FieldsSection({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const { entries, inputFields, openEntry, duplicateNames } = useValues(appConfigFormLogic(logicProps))
  const { toggleEntry, moveEntry, removeEntry, addField, addMarkdown } = useActions(appConfigFormLogic(logicProps))
  return (
    <Section title="Fields" description="What a scene sets on this app's node, in the order shown there.">
      {duplicateNames.length ? (
        <p className="text-xs text-red-500">
          Two fields share the codename {duplicateNames.map((name) => `"${name}"`).join(', ')}. Each needs its own.
        </p>
      ) : null}
      {entries.length ? (
        <div className="space-y-2">
          {entries.map((entry, index) => {
            const { title, detail, tags } = entrySummary(entry)
            const open = openEntry === index
            const siblings = inputFields.filter((field: AppConfigField) => field !== entry && !!field.name)
            return (
              <div key={index} className={clsx('frameos-inset rounded-xl border', open && 'ring-1 ring-blue-400/40')}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleEntry(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleEntry(index)
                    }
                  }}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="frameos-strong truncate text-sm font-semibold">{title}</div>
                    <div className="frameos-muted truncate text-xs">{detail}</div>
                  </div>
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="frameos-muted hidden rounded-full border px-2 py-0.5 text-[11px] @md:inline"
                    >
                      {tag}
                    </span>
                  ))}
                  <IconButton title="Move up" disabled={index === 0} onClick={() => moveEntry(index, -1)}>
                    <ArrowUpIcon className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    title="Move down"
                    disabled={index === entries.length - 1}
                    onClick={() => moveEntry(index, 1)}
                  >
                    <ArrowDownIcon className="h-4 w-4" />
                  </IconButton>
                  <IconButton title="Remove" danger onClick={() => removeEntry(index)}>
                    <TrashIcon className="h-4 w-4" />
                  </IconButton>
                </div>
                {open ? (
                  isMarkdownEntry(entry) ? (
                    <MarkdownEditor logicProps={logicProps} entry={entry} index={index} siblings={siblings} />
                  ) : (
                    <FieldEditor logicProps={logicProps} field={entry} index={index} siblings={siblings} />
                  )
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="frameos-muted text-xs">No fields yet. The app runs with no settings of its own.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="small" color="secondary" onClick={addField} className="flex items-center gap-1">
          <PlusIcon className="h-4 w-4" /> Add field
        </Button>
        <Button size="small" color="secondary" onClick={addMarkdown} className="flex items-center gap-1">
          <PlusIcon className="h-4 w-4" /> Add text
        </Button>
      </div>
    </Section>
  )
}

function OutputSection({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const { outputs } = useValues(appConfigFormLogic(logicProps))
  const { updateOutput, removeOutput, addOutput } = useActions(appConfigFormLogic(logicProps))
  const typeOptions = fieldTypes.map((type) => ({ value: type, label: OUTPUT_TYPE_LABELS[type] ?? type }))
  return (
    <Section title="Output" description="What the app returns: an image to draw, or a value for the next node.">
      {outputs.map((output: OutputField, index: number) => (
        <div key={index} className="grid items-end gap-2 @md:grid-cols-[1fr_1fr_1.5fr_auto]">
          <Row label="Name">
            <TextInput value={output.name} onChange={(name) => updateOutput(index, { name })} />
          </Row>
          <Row label="Type">
            <Select value={output.type} options={typeOptions} onChange={(type) => updateOutput(index, { type })} />
          </Row>
          <Row label="Example">
            <TextInput
              value={output.example ?? ''}
              placeholder="Shown in the editor"
              onChange={(example) => updateOutput(index, { example: example || undefined })}
            />
          </Row>
          <IconButton title="Remove output" danger onClick={() => removeOutput(index)}>
            <TrashIcon className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      {outputs.length === 0 ? <p className="frameos-muted text-xs">No output: the app returns nothing.</p> : null}
      <Button size="small" color="secondary" onClick={addOutput} className="flex items-center gap-1">
        <PlusIcon className="h-4 w-4" /> Add output
      </Button>
    </Section>
  )
}

function SettingsSection({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const { settings } = useValues(appConfigFormLogic(logicProps))
  const { setConfigKey } = useActions(appConfigFormLogic(logicProps))
  const known = Object.keys(settingsDetails)
  const custom = settings.filter((key: string) => !known.includes(key))
  const toggle = (key: string, on: boolean): void =>
    setConfigKey(
      'settings',
      on
        ? [...settings.filter((other: string) => other !== key), key]
        : settings.filter((other: string) => other !== key)
    )
  return (
    <Section
      title="Settings"
      description="Keys and accounts the app reads with frameos.getSetting. A frame asks its owner for the ones listed here."
    >
      <div className="grid gap-2 @md:grid-cols-2">
        {known.map((key) => (
          <Switch
            key={key}
            label={settingsDetails[key].title}
            value={settings.includes(key)}
            onChange={(on) => toggle(key, on)}
          />
        ))}
      </div>
      <Row label="Other settings" hint="Comma separated names of other settings groups.">
        <ListInput
          value={custom}
          onChange={(others) =>
            setConfigKey('settings', [...settings.filter((key: string) => known.includes(key)), ...others])
          }
        />
      </Row>
    </Section>
  )
}

function PermissionsSection({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const { permissions } = useValues(appConfigFormLogic(logicProps))
  return (
    <Section
      title="Permissions"
      description="Filled in from the app's code each time you save, and given to the app on the frame."
    >
      {permissions.length ? (
        <ul className="flex flex-wrap gap-2">
          {permissions.map((permission: string) => (
            <li key={permission} className="frameos-inset rounded-full border px-2.5 py-1 text-xs font-semibold">
              {PERMISSION_LABELS[permission] ?? permission}
            </li>
          ))}
        </ul>
      ) : (
        <p className="frameos-muted text-xs">None. The app only reaches the network and its own data.</p>
      )}
    </Section>
  )
}

function CacheSection({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const { cache } = useValues(appConfigFormLogic(logicProps))
  const { updateCache } = useActions(appConfigFormLogic(logicProps))
  return (
    <Section
      title="Cache"
      description="How a new node of this app keeps its result between renders. Each node can change it."
    >
      <div>
        <Switch
          label="Cache the returned value"
          value={!!cache.enabled}
          onChange={(enabled) => updateCache({ enabled })}
        />
      </div>
      {cache.enabled ? (
        <div className="space-y-3 border-l pl-4">
          <div>
            <Switch
              label="Refresh when inputs change"
              value={!!cache.inputEnabled}
              onChange={(inputEnabled) => updateCache({ inputEnabled: inputEnabled || undefined })}
            />
          </div>
          <div>
            <Switch
              label="Refresh after a while"
              value={!!cache.durationEnabled}
              onChange={(durationEnabled) => updateCache({ durationEnabled: durationEnabled || undefined })}
            />
          </div>
          {cache.durationEnabled ? (
            <Row label="Seconds">
              <TextInput
                value={cache.duration ?? ''}
                placeholder="60"
                onChange={(duration) => updateCache({ duration: duration || undefined })}
              />
            </Row>
          ) : null}
          <div>
            <Switch
              label="Refresh when an expression changes"
              value={!!cache.expressionEnabled}
              onChange={(expressionEnabled) => updateCache({ expressionEnabled: expressionEnabled || undefined })}
            />
          </div>
          {cache.expressionEnabled ? (
            <div className="grid gap-3 @md:grid-cols-2">
              <Row label="Expression">
                <TextInput
                  className="font-mono"
                  value={cache.expression ?? ''}
                  placeholder="state.city"
                  onChange={(expression) => updateCache({ expression: expression || undefined })}
                />
              </Row>
              <Row label="Its type">
                <Select
                  value={cache.expressionType ?? 'string'}
                  options={fieldTypes.map((type) => ({ value: type, label: type }))}
                  onChange={(expressionType) => updateCache({ expressionType })}
                />
              </Row>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

export function AppConfigForm({ logicProps }: { logicProps: EditAppLogicProps }): JSX.Element {
  const logic = appConfigFormLogic(logicProps)
  const { config, configError, apt, requiresCompiledOnSave } = useValues(logic)
  const { setConfigKey, setShowConfigSource } = useActions(logic)
  if (!config) {
    return (
      <div className="frame-tool-card space-y-3 rounded-2xl p-4 text-sm">
        <p>
          <span className="font-semibold">config.json does not parse, so the form cannot show it.</span>{' '}
          <span className="frameos-muted">{configError}</span>
        </p>
        <Button size="small" color="secondary" onClick={() => setShowConfigSource(true)}>
          Fix it in the source
        </Button>
      </div>
    )
  }
  const text = (key: string): string => (typeof config[key] === 'string' ? (config[key] as string) : '')
  const category = text('category')
  const categoryOptions = [
    { value: '', label: 'None' },
    ...CATEGORIES,
    ...(category && !CATEGORIES.some((option) => option.value === category)
      ? [{ value: category, label: category }]
      : []),
  ]
  return (
    <fieldset disabled={requiresCompiledOnSave} className="@container min-w-0 space-y-3 pb-4">
      <Section title="App">
        <div className="grid gap-3 @md:grid-cols-2">
          <Row label="Name" hint={text('name').trim() ? undefined : 'Required'}>
            <TextInput value={text('name')} onChange={(name) => setConfigKey('name', name)} />
          </Row>
          <Row label="Category">
            <Select value={category} options={categoryOptions} onChange={(value) => setConfigKey('category', value)} />
          </Row>
          <Row label="Version">
            <TextInput
              value={text('version')}
              placeholder="1.0.0"
              onChange={(version) => setConfigKey('version', version)}
            />
          </Row>
          {text('origin') ? (
            <Row label="Made from" compound>
              <div className="frameos-muted truncate py-1.5 font-mono text-xs" title={text('origin')}>
                {text('origin')}
              </div>
            </Row>
          ) : null}
        </div>
        <Row label="Description">
          <TextArea
            rows={2}
            value={text('description')}
            onChange={(description) => setConfigKey('description', description)}
          />
        </Row>
      </Section>
      <FieldsSection logicProps={logicProps} />
      <OutputSection logicProps={logicProps} />
      <SettingsSection logicProps={logicProps} />
      <PermissionsSection logicProps={logicProps} />
      <CacheSection logicProps={logicProps} />
      <AdvancedSection label="Linux packages" open={apt.length > 0} className="px-1">
        <Row
          label="apt packages"
          hint="Installed on Raspberry Pi OS frames when a scene with this app is deployed. Comma separated."
        >
          <ListInput value={apt} onChange={(packages) => setConfigKey('apt', packages)} />
        </Row>
      </AdvancedSection>
    </fieldset>
  )
}
