import { Fragment, type DragEvent } from 'react'
import { Form, Group } from 'kea-forms'
import { frameLogic } from '../../frameLogic'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { TextInput } from '../../../../components/TextInput'
import { FrameImage } from '../../../../components/FrameImage'
import { useActions, useValues } from 'kea'
import { scheduleLogic } from './scheduleLogic'
import { CalendarDaysIcon } from '@heroicons/react/24/outline'
import { PlusIcon } from '@heroicons/react/24/solid'
import { StateFieldEdit } from '../Scenes/StateFieldEdit'
import { FrameScene, ScheduledEvent, StateField } from '../../../../types'
import { Switch } from '../../../../components/Switch'
import clsx from 'clsx'
import { getFrameosSceneDragData, hasFrameosSceneDragData, setFrameosSceneDragData } from '../../../workspace/sceneDrag'

const weekDayOptions = [
  { value: 0, label: 'Every day' },
  { value: 8, label: 'Weekdays' },
  { value: 9, label: 'Weekends' },
  { value: 1, label: 'Mondays' },
  { value: 2, label: 'Tuesdays' },
  { value: 3, label: 'Wednesdays' },
  { value: 4, label: 'Thursdays' },
  { value: 5, label: 'Fridays' },
  { value: 6, label: 'Saturdays' },
  { value: 7, label: 'Sundays' },
]
const weekDays = Object.fromEntries(weekDayOptions.map((option) => [option.value, option.label]))

const hourOptions = [...Array(24).keys()].map((hour) => ({
  value: hour,
  label: hour < 10 ? `0${hour}` : hour.toString(),
}))
const minuteOptions = [...Array(60).keys()].map((minute) => ({
  value: minute,
  label: minute < 10 ? `0${minute}` : minute.toString(),
}))

function timeLabel(event: ScheduledEvent): string {
  return `${event.hour < 10 ? '0' : ''}${event.hour}:${event.minute < 10 ? '0' : ''}${event.minute}`
}

function sceneName(scene: FrameScene | null | undefined, fallback = 'Unspecified scene'): string {
  return scene?.name || scene?.id || fallback
}

function entryCountLabel(count: number): string {
  if (count === 0) {
    return 'Not scheduled'
  }
  return `${count} ${count === 1 ? 'entry' : 'entries'}`
}

interface SceneScheduleCardProps {
  frameId: number
  scene: FrameScene
  eventCount: number
  layout: 'strip' | 'grid' | 'responsive'
  addEventForScene: (sceneId: string) => void
  showDropZone: () => void
  hideDropZone: () => void
}

function SceneScheduleCard({
  frameId,
  scene,
  eventCount,
  layout,
  addEventForScene,
  showDropZone,
  hideDropZone,
}: SceneScheduleCardProps): JSX.Element {
  return (
    <button
      type="button"
      draggable={Boolean(scene.id)}
      onDragStart={(dragEvent) => {
        if (scene.id) {
          setFrameosSceneDragData(dragEvent.dataTransfer, scene.id)
          showDropZone()
        }
      }}
      onDragEnd={hideDropZone}
      onClick={() => addEventForScene(scene.id)}
      className={clsx(
        'frameos-primary-hover-border group relative flex overflow-hidden rounded-2xl border border-[var(--tool-border)] bg-[var(--tool-bg-strong)] text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        layout === 'grid'
          ? 'min-w-0'
          : layout === 'responsive'
          ? 'min-w-[8.5rem] max-w-[9.5rem] flex-none @5xl:min-w-0 @5xl:max-w-none @5xl:flex-1'
          : 'min-w-[8.5rem] max-w-[9.5rem] flex-none'
      )}
      title={`Add ${sceneName(scene)} to the schedule`}
    >
      <div className="flex w-full flex-col">
        <div className="relative aspect-[4/3] overflow-hidden bg-slate-200/60">
          <FrameImage
            frameId={frameId}
            sceneId={scene.id}
            thumb
            refreshable={false}
            objectFit="cover"
            className="h-full w-full rounded-none transition duration-200 group-hover:scale-[1.03]"
          />
          <span className="frameos-primary-text absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow-sm">
            <PlusIcon className="h-4 w-4" />
          </span>
        </div>
        <div className="min-w-0 px-3 py-2">
          <div className="truncate text-sm font-semibold">{sceneName(scene)}</div>
          <div className="frame-tool-muted mt-0.5 text-xs">{entryCountLabel(eventCount)}</div>
        </div>
      </div>
    </button>
  )
}

interface ScheduleEntryCardProps {
  frameId: number
  event: ScheduledEvent
  scene: FrameScene | null
  className?: string
}

interface ScheduleEntryDropTargetProps {
  index: number
  children: JSX.Element
  addEventForScene: (sceneId: string, insertIndex?: number | null) => void
  hideDropZone: () => void
  setDropIndex: (dropIndex: number | null) => void
  showDropZone: () => void
}

interface ScheduleDropSlotProps {
  index: number
  active: boolean
  addEventForScene: (sceneId: string, insertIndex?: number | null) => void
  hideDropZone: () => void
  setDropIndex: (dropIndex: number | null) => void
  showDropZone: () => void
}

function ScheduleDropSlot({
  index,
  active,
  addEventForScene,
  hideDropZone,
  setDropIndex,
  showDropZone,
}: ScheduleDropSlotProps): JSX.Element {
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    showDropZone()
    setDropIndex(index)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      hideDropZone()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    addEventForScene(sceneId, index)
  }

  return (
    <div
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={clsx('relative z-30 flex h-6 items-center transition-all', active ? 'h-10' : '')}
    >
      <div
        className={clsx(
          'w-full rounded-full border-2 border-dashed transition-all',
          active ? 'frameos-primary-drop-target h-8' : 'frameos-primary-drop-placeholder h-2 bg-white/55'
        )}
      />
    </div>
  )
}

function scheduleEntryDropIndex(event: DragEvent<HTMLDivElement>, index: number): number {
  const rect = event.currentTarget.getBoundingClientRect()
  const midpoint = rect.top + rect.height / 2
  return event.clientY < midpoint ? index : index + 1
}

function ScheduleEntryDropTarget({
  index,
  children,
  addEventForScene,
  hideDropZone,
  setDropIndex,
  showDropZone,
}: ScheduleEntryDropTargetProps): JSX.Element {
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    showDropZone()
    setDropIndex(scheduleEntryDropIndex(event, index))
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      hideDropZone()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    addEventForScene(sceneId, scheduleEntryDropIndex(event, index))
  }

  return (
    <div onDragEnter={handleDragOver} onDragOver={handleDragOver} onDrop={handleDrop}>
      {children}
    </div>
  )
}

function ScheduleEntryCard({ frameId, event, scene, className }: ScheduleEntryCardProps): JSX.Element {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 rounded-2xl border border-[var(--tool-border)] bg-[var(--tool-bg-strong)] p-2',
        className
      )}
    >
      <div className="h-16 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-200/60">
        {scene ? (
          <FrameImage
            frameId={frameId}
            sceneId={scene.id}
            thumb
            refreshable={false}
            objectFit="cover"
            className="h-full w-full rounded-none"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <CalendarDaysIcon className="h-6 w-6 text-slate-400" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-semibold">{sceneName(scene)}</div>
          {event.disabled ? (
            <span className="shrink-0 rounded-full bg-slate-500/12 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
              Disabled
            </span>
          ) : null}
        </div>
        <div className="frame-tool-muted mt-0.5 text-xs">
          {weekDays[String(event.weekday || 0)]} at {timeLabel(event)}
        </div>
      </div>
    </div>
  )
}

interface EditRowProps {
  frameId: number
  event: ScheduledEvent
  scene: FrameScene | null
  eventFields: StateField[]
  closeEvent: (id: string) => void
  deleteEvent: (id: string) => void
}

function CompactScheduleField({
  label,
  children,
  className,
}: {
  label: string
  children: JSX.Element
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('min-w-0 space-y-1', className)}>
      <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">{label}</div>
      {children}
    </div>
  )
}

function EditRow({ frameId, event, scene, eventFields, closeEvent, deleteEvent }: EditRowProps) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => closeEvent(event.id)}
        className="group w-full rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <ScheduleEntryCard
          frameId={frameId}
          event={event}
          scene={scene}
          className="frameos-primary-group-hover-border transition group-hover:shadow-lg"
        />
      </button>
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-[minmax(8rem,1fr)_minmax(4.5rem,5rem)_minmax(4.5rem,5rem)]">
        <CompactScheduleField label="Repeats" className="col-span-2 @md:col-span-1">
          <Field name="weekday" className="@md:!block">
            {({ value, onChange }) => (
              <Select
                options={weekDayOptions}
                value={value}
                onChange={(value_) => onChange(parseInt(value_))}
                className="h-9 min-w-0"
              />
            )}
          </Field>
        </CompactScheduleField>
        <CompactScheduleField label="Hour">
          <Field name="hour" className="@md:!block">
            {({ value, onChange }) => (
              <Select
                value={value}
                onChange={(value_) => onChange(parseInt(value_))}
                options={hourOptions}
                className="h-9 min-w-0 px-2"
              />
            )}
          </Field>
        </CompactScheduleField>
        <CompactScheduleField label="Minute">
          <Field name="minute" className="@md:!block">
            {({ value, onChange }) => (
              <Select
                value={value}
                onChange={(value_) => onChange(parseInt(value_))}
                options={minuteOptions}
                className="h-9 min-w-0 px-2"
              />
            )}
          </Field>
        </CompactScheduleField>
      </div>
      <Group name="payload">
        {event.payload.sceneId ? (
          <Group name="state">
            <div className="mt-3 space-y-3">
              {eventFields
                .filter((field) => field.access === 'public')
                .map((field) => (
                  <Field key={field.name} name={field.name} label={field.label || field.name}>
                    {({ value, onChange }) => (
                      <StateFieldEdit
                        field={field}
                        value={value}
                        onChange={onChange}
                        currentState={{}}
                        stateChanges={{}}
                      />
                    )}
                  </Field>
                ))}
            </div>
          </Group>
        ) : null}
      </Group>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-500/20 pt-4">
        <Field name="disabled">
          {({ value, onChange }) => (
            <Switch label="Entry enabled" value={!value} onChange={(enabled) => onChange(!enabled)} />
          )}
        </Field>
        <div className="flex gap-2">
          <Button
            color="secondary"
            onClick={(event_) => {
              event_.stopPropagation()
              deleteEvent(event.id)
            }}
          >
            Delete
          </Button>
          <Button
            color="primary"
            onClick={(event_) => {
              event_.stopPropagation()
              closeEvent(event.id)
            }}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ScheduleProps {
  scrollContainer?: boolean
  drawerMode?: boolean
}

export function Schedule({ scrollContainer = true, drawerMode = false }: ScheduleProps = {}) {
  const { frameId } = useValues(frameLogic)
  const {
    dropIndex,
    dropZoneVisible,
    editingEvents,
    events,
    filteredScenes,
    sceneSearch,
    sortedEvents,
    sortedScenes,
    fieldsForScene,
    disabled,
    eventCountsByScene,
  } = useValues(scheduleLogic({ frameId }))
  const {
    editEvent,
    addEventForScene,
    closeEvent,
    deleteEvent,
    hideDropZone,
    setDropIndex,
    setSceneSearch,
    showDropZone,
  } = useActions(scheduleLogic({ frameId }))
  const scenesById = Object.fromEntries(sortedScenes.map((scene) => [scene.id, scene]))

  const dragIsInsidePanel = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    )
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    showDropZone()
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    showDropZone()
    setDropIndex(null)
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer) || dragIsInsidePanel(event)) {
      return
    }
    hideDropZone()
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      hideDropZone()
      return
    }
    event.preventDefault()
    addEventForScene(sceneId, dropIndex ?? sortedEvents.length)
  }

  const sceneCardLayout = drawerMode ? 'strip' : 'responsive'
  const scenePicker = (
    <div className="frame-tool-card overflow-hidden rounded-[22px]">
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <TextInput
            value={sceneSearch}
            onChange={setSceneSearch}
            placeholder="Find scenes..."
            className="h-9 rounded-xl"
          />
          <div className="frame-tool-muted shrink-0 text-xs">
            {filteredScenes.length}/{sortedScenes.length}
          </div>
        </div>
        {filteredScenes.length ? (
          <div
            className={clsx(
              drawerMode
                ? '-mx-1 flex gap-3 overflow-x-auto px-1 pb-1'
                : '-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 @5xl:mx-0 @5xl:grid @5xl:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] @5xl:overflow-visible @5xl:px-0 @5xl:pb-0'
            )}
          >
            {filteredScenes.map((scene) => (
              <SceneScheduleCard
                key={scene.id}
                frameId={frameId}
                scene={scene}
                eventCount={eventCountsByScene[scene.id] ?? 0}
                layout={sceneCardLayout}
                addEventForScene={addEventForScene}
                showDropZone={showDropZone}
                hideDropZone={hideDropZone}
              />
            ))}
          </div>
        ) : sortedScenes.length ? (
          <div className="rounded-2xl border border-dashed border-[var(--tool-border)] px-4 py-5 text-center">
            <div className="text-sm font-semibold">No matching scenes</div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--tool-border)] px-4 py-5 text-center">
            <div className="text-sm font-semibold">No scenes yet</div>
            <div className="frame-tool-muted mt-1 text-xs">Create scenes before scheduling them.</div>
          </div>
        )}
      </div>
    </div>
  )

  const scheduleEntries = (
    <div className="space-y-2">
      {dropZoneVisible ? (
        <ScheduleDropSlot
          index={0}
          active={dropIndex === 0}
          addEventForScene={addEventForScene}
          hideDropZone={hideDropZone}
          setDropIndex={setDropIndex}
          showDropZone={showDropZone}
        />
      ) : null}
      {sortedEvents.length === 0 ? (
        <div className="frame-tool-card rounded-[22px] border-dashed p-5 text-center">
          <div className="text-sm font-semibold">No scheduled scenes. Drag one here.</div>
        </div>
      ) : null}
      {sortedEvents.map((event, sortedIndex) => {
        const eventIndex = events.findIndex((candidate) => candidate.id === event.id)
        if (eventIndex === -1) {
          return null
        }
        const scene = scenesById[event.payload.sceneId] ?? null
        const inactive = event.disabled || disabled

        return (
          <Fragment key={event.id}>
            {editingEvents[event.id] ? (
              <ScheduleEntryDropTarget
                index={sortedIndex}
                addEventForScene={addEventForScene}
                hideDropZone={hideDropZone}
                setDropIndex={setDropIndex}
                showDropZone={showDropZone}
              >
                <div
                  className={clsx(
                    'frame-tool-card @container rounded-[22px] p-4 transition',
                    inactive ? 'opacity-70' : ''
                  )}
                >
                  <Group name={['schedule', 'events', eventIndex]}>
                    <EditRow
                      frameId={frameId}
                      event={event}
                      scene={scene}
                      eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                      closeEvent={closeEvent}
                      deleteEvent={deleteEvent}
                    />
                  </Group>
                </div>
              </ScheduleEntryDropTarget>
            ) : (
              <ScheduleEntryDropTarget
                index={sortedIndex}
                addEventForScene={addEventForScene}
                hideDropZone={hideDropZone}
                setDropIndex={setDropIndex}
                showDropZone={showDropZone}
              >
                <button
                  type="button"
                  draggable={Boolean(event.payload.sceneId)}
                  onDragStart={(dragEvent) => {
                    if (event.payload.sceneId) {
                      setFrameosSceneDragData(dragEvent.dataTransfer, event.payload.sceneId)
                      showDropZone()
                    }
                  }}
                  onDragEnd={hideDropZone}
                  onClick={() => editEvent(event.id)}
                  className={clsx(
                    'group @container w-full rounded-2xl text-left transition hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    inactive ? 'opacity-70' : ''
                  )}
                >
                  <ScheduleEntryCard
                    frameId={frameId}
                    event={event}
                    scene={scene}
                    className="frameos-primary-group-hover-border transition group-hover:shadow-lg"
                  />
                </button>
              </ScheduleEntryDropTarget>
            )}
            {dropZoneVisible ? (
              <ScheduleDropSlot
                index={sortedIndex + 1}
                active={dropIndex === sortedIndex + 1}
                addEventForScene={addEventForScene}
                hideDropZone={hideDropZone}
                setDropIndex={setDropIndex}
                showDropZone={showDropZone}
              />
            ) : null}
          </Fragment>
        )
      })}
    </div>
  )

  const scheduleColumn = (
    <div className="space-y-3">
      <div className="flex justify-start px-1">
        <Field name={['schedule', 'disabled']}>
          {({ value, onChange }) => (
            <Switch label="Enable schedule" value={!value} onChange={(enabled) => onChange(!enabled)} />
          )}
        </Field>
      </div>
      {scheduleEntries}
    </div>
  )

  return (
    <div
      className={clsx(
        'frame-tool-panel @container relative min-h-full',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible'
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropZoneVisible ? (
        <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-[color:var(--tool-border)] bg-[var(--tool-bg-strong)] px-3 py-1.5 text-xs font-semibold text-[color:var(--tool-strong)] shadow-sm">
          Drop into schedule
        </div>
      ) : null}
      <Form logic={frameLogic} formKey="frameForm" className="space-y-4">
        <div
          className={clsx(
            drawerMode
              ? 'space-y-4'
              : 'grid gap-5 @5xl:grid-cols-[minmax(17rem,0.8fr)_minmax(24rem,1.2fr)] @5xl:items-start'
          )}
        >
          {scenePicker}
          {scheduleColumn}
        </div>
      </Form>
    </div>
  )
}
