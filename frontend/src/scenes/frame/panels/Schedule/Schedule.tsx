import type { DragEvent } from 'react'
import { Form, Group } from 'kea-forms'
import { frameLogic } from '../../frameLogic'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { useActions, useValues } from 'kea'
import { scheduleLogic } from './scheduleLogic'
import { EyeIcon, PencilSquareIcon } from '@heroicons/react/24/outline'
import { PlusIcon } from '@heroicons/react/24/solid'
import { StateFieldEdit } from '../Scenes/StateFieldEdit'
import { ScheduledEvent, StateField } from '../../../../types'
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

interface ViewRowProps {
  event: ScheduledEvent
  disabled: boolean
  sceneLabel: string
  eventFields: StateField[]
  expandedDescription: boolean
  toggleDescription: (id: string) => void
  editEvent: (id: string) => void
  sendEvent: (event: string, payload: any) => void
}

function ViewRow({
  event,
  disabled,
  sceneLabel,
  eventFields,
  expandedDescription,
  editEvent,
  toggleDescription,
  sendEvent,
}: ViewRowProps) {
  const publicFields = eventFields.filter((field) => field.access === 'public')
  const modifiedFields = publicFields.filter(
    (field) => field.name in event.payload.state && event.payload.state[field.name] !== field.value
  )
  const shownFields = expandedDescription ? publicFields : modifiedFields
  const showToggle = publicFields.length !== modifiedFields.length
  const inactive = event.disabled || disabled

  return (
    <div
      draggable={Boolean(event.payload.sceneId)}
      onDragStart={(dragEvent) => {
        if (event.payload.sceneId) {
          setFrameosSceneDragData(dragEvent.dataTransfer, event.payload.sceneId)
        }
      }}
      className={clsx('space-y-3', inactive && 'opacity-55')}
    >
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'flex h-14 w-16 shrink-0 flex-col items-center justify-center rounded-2xl border text-center',
            inactive ? 'border-slate-300/60 bg-slate-100/60' : 'border-[#4a4b8c]/20 bg-[#4a4b8c]/10'
          )}
        >
          <div className="text-base font-bold leading-none">{timeLabel(event)}</div>
          <div className="frame-tool-muted mt-1 text-[10px] font-semibold uppercase leading-none">
            {weekDays[String(event.weekday || 0)]}
          </div>
        </div>
        <button
          type="button"
          onClick={() => (showToggle ? toggleDescription(event.id) : undefined)}
          className="min-w-0 flex-1 rounded-xl px-1 py-0.5 text-left transition hover:bg-white/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <div className="truncate text-sm font-semibold">{sceneLabel}</div>
          <div className="frame-tool-muted mt-1 flex flex-wrap gap-1 text-xs">
            {modifiedFields.length ? (
              modifiedFields.map((field) => (
                <span key={field.name} className="rounded-full bg-slate-500/10 px-2 py-0.5">
                  {field.label || field.name}
                </span>
              ))
            ) : (
              <span>No state overrides</span>
            )}
          </div>
        </button>
        <div className="flex shrink-0 gap-1">
          <Button
            size="small"
            className="!px-1"
            color="secondary"
            onClick={(event_) => {
              event_.stopPropagation()
              sendEvent(event.event, event.payload)
            }}
            title="Preview scheduled scene"
          >
            <EyeIcon className="w-5 h-5" />
          </Button>
          <Button
            size="small"
            className="!px-1"
            color="secondary"
            onClick={(event_) => {
              event_.stopPropagation()
              editEvent(event.id)
            }}
            title="Edit"
          >
            <PencilSquareIcon className="w-5 h-5" />
          </Button>
        </div>
      </div>
      {shownFields.length ? (
        <div className="grid gap-2 pl-0 text-sm @md:pl-[4.75rem]">
          {shownFields.map((field) => (
            <div key={field.name} className="grid gap-1 rounded-xl bg-slate-500/10 px-3 py-2 @md:grid-cols-3">
              <div className="frame-tool-muted text-xs font-semibold uppercase">{field.label || field.name}</div>
              <div className="min-w-0 truncate @md:col-span-2">{event.payload.state[field.name] ?? field.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface EditRowProps {
  event: ScheduledEvent
  scenesAsOptions: { label: string; value: string }[]
  eventFields: StateField[]
  closeEvent: (id: string) => void
  deleteEvent: (id: string) => void
}

function EditRow({ event, scenesAsOptions, eventFields, closeEvent, deleteEvent }: EditRowProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(6rem,1fr)_4rem_4rem] gap-2">
        <Field name="weekday" label="Repeats" className="min-w-0">
          {({ value, onChange }) => (
            <Select options={weekDayOptions} value={value} onChange={(value_) => onChange(parseInt(value_))} />
          )}
        </Field>
        <Field name="hour" label="Hour" className="min-w-0">
          {({ value, onChange }) => (
            <Select
              value={value}
              onChange={(value_) => onChange(parseInt(value_))}
              options={hourOptions}
              className="px-2"
            />
          )}
        </Field>
        <Field name="minute" label="Minute" className="min-w-0">
          {({ value, onChange }) => (
            <Select
              value={value}
              onChange={(value_) => onChange(parseInt(value_))}
              options={minuteOptions}
              className="px-2"
            />
          )}
        </Field>
      </div>
      <Group name="payload">
        <Field name="sceneId" label="Scene">
          <Select options={scenesAsOptions} />
        </Field>
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
            <Switch label="Enabled" value={!value} onChange={(enabled) => onChange(!enabled)} />
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
  const { sendEvent } = useActions(frameLogic)
  const { editingEvents, events, sortedEvents, scenesAsOptions, fieldsForScene, expandedDescriptions, sort, disabled } =
    useValues(scheduleLogic({ frameId }))
  const { editEvent, addEvent, addEventForScene, closeEvent, deleteEvent, toggleDescription, setSort } = useActions(
    scheduleLogic({ frameId })
  )

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFrameosSceneDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const sceneId = getFrameosSceneDragData(event.dataTransfer)
    if (!sceneId) {
      return
    }
    event.preventDefault()
    addEventForScene(sceneId)
  }

  return (
    <div
      className={clsx('frame-tool-panel @container', scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible')}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <Form logic={frameLogic} formKey="frameForm" className="space-y-4">
        <div className="frame-tool-card rounded-[22px] p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="frame-tool-heading text-base font-semibold">
                {drawerMode ? 'Scene schedule' : 'Schedule'}
              </h3>
              <div className="frame-tool-muted mt-1 text-sm">
                {events.length} {events.length === 1 ? 'entry' : 'entries'} · {disabled ? 'Paused' : 'Enabled'}
              </div>
            </div>
            <Field name={['schedule', 'disabled']}>
              {({ value, onChange }) => (
                <Switch label="Enabled" value={!value} onChange={(enabled) => onChange(!enabled)} />
              )}
            </Field>
          </div>
          <div className="grid gap-2 @md:grid-cols-[1fr_auto]">
            <Select
              options={[
                { label: 'Sort by hour', value: 'hour' },
                { label: 'Sort by day', value: 'day' },
                { label: 'Sort by scene', value: 'scene' },
              ]}
              value={sort}
              onChange={setSort}
            />
            <Button onClick={() => addEvent()} size="small" className="flex items-center justify-center gap-1">
              <PlusIcon className="w-5 h-5" />
              Add entry
            </Button>
          </div>
        </div>
        {sortedEvents.length === 0 ? (
          <div className="frame-tool-card rounded-[22px] border-dashed p-5 text-center">
            <div className="text-sm font-semibold">No scheduled scenes</div>
            <div className="frame-tool-muted mt-1 text-xs">Schedule entries appear here.</div>
          </div>
        ) : null}
        {sortedEvents.map((event) => {
          const eventIndex = events.findIndex((candidate) => candidate.id === event.id)
          if (eventIndex === -1) {
            return null
          }
          const sceneLabel =
            scenesAsOptions.find((scene) => scene.value === event.payload.sceneId)?.label || 'Unspecified scene'

          return (
            <div
              className={clsx(
                'frame-tool-card @container rounded-[22px] p-4 transition',
                !editingEvents[event.id] && (event.disabled || disabled) ? 'opacity-70' : ''
              )}
              key={event.id}
            >
              {editingEvents[event.id] ? (
                <Group name={['schedule', 'events', eventIndex]}>
                  <EditRow
                    event={event}
                    scenesAsOptions={scenesAsOptions}
                    eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                    closeEvent={closeEvent}
                    deleteEvent={deleteEvent}
                  />
                </Group>
              ) : (
                <ViewRow
                  disabled={disabled}
                  event={event}
                  sceneLabel={sceneLabel}
                  eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                  expandedDescription={expandedDescriptions[event.id] ?? false}
                  toggleDescription={toggleDescription}
                  editEvent={editEvent}
                  sendEvent={sendEvent}
                />
              )}
            </div>
          )
        })}
      </Form>
    </div>
  )
}
