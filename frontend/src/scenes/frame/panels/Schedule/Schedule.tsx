import { Form, Group } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { useActions, useValues } from 'kea'
import { scheduleLogic } from './scheduleLogic'
import { PencilSquareIcon } from '@heroicons/react/24/outline'
import { PlayIcon, PlusIcon } from '@heroicons/react/24/solid'
import { StateFieldEdit } from '../Scenes/StateFieldEdit'
import { ScheduledEvent, StateField } from '../../../../types'
import { Switch } from '../../../../components/Switch'
import clsx from 'clsx'

const weekDayOptions = [
  { value: 0, label: 'Every day' },
  { value: 8, label: 'Every weekday' },
  { value: 9, label: 'Every weekend' },
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

interface ViewRowProps {
  event: ScheduledEvent
  disabled: boolean
  scenesAsOptions: { label: string; value: string }[]
  eventFields: StateField[]
  expandedDescription: boolean
  toggleDescription: (id: string) => void
  editEvent: (id: string) => void
  sendEvent: (event: string, payload: any) => void
}

function ViewRow({
  event,
  disabled,
  scenesAsOptions,
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
  const showToggle = publicFields.length != modifiedFields.length

  return (
    <>
      <div className={clsx('flex justify-between items-start', (event.disabled || disabled) && 'line-through')}>
        <div className="w-full py-1">
          {weekDays[String(event.weekday || 0)]} at {event.hour < 10 ? '0' : ''}
          {event.hour}:{event.minute < 10 ? '0' : ''}
          {event.minute}
        </div>
        <div className="flex gap-1">
          <Button
            size="small"
            className="!px-1"
            color="secondary"
            onClick={(e) => {
              e.stopPropagation()
              sendEvent(event.event, event.payload)
            }}
            title="Activate"
          >
            <PlayIcon className="w-5 h-5" />
          </Button>
          <Button
            size="small"
            className="!px-1"
            color="secondary"
            onClick={(e) => {
              e.stopPropagation()
              editEvent(event.id)
            }}
            title="Edit"
          >
            <PencilSquareIcon className="w-5 h-5" />
          </Button>
        </div>
      </div>
      <div
        className={showToggle ? 'font-bold cursor-pointer space-x-1' : 'font-bold space-x-2'}
        onClick={() => toggleDescription(event.id)}
      >
        <span>
          {scenesAsOptions.find((scene) => scene.value === event.payload.sceneId)?.label || 'Unspecified Scene'}
        </span>
        {showToggle ? (
          <span className="text-xs font-normal text-gray-500">[{expandedDescription ? 'hide' : 'expand'}]</span>
        ) : null}
      </div>
      {(expandedDescription ? publicFields : modifiedFields).map((field) => (
        <div
          key={field.name}
          className="flex gap-1 @container w-full flex-col items-start @md:items-center @md:flex-row"
        >
          <div className="@md:w-1/3 text-xs font-normal text-gray-500 mb-[-0.25rem] @md:mb-0">
            {field.label || field.name}
          </div>
          <div className="@md:w-2/3">{event.payload.state[field.name] ?? field.value}</div>
        </div>
      ))}
    </>
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
    <>
      <Field name="weekday" label="When">
        {({ value, onChange }) => (
          <div className="w-full space-y-2">
            <Select options={weekDayOptions} value={value} onChange={(v) => onChange(parseInt(v))} />
            <div className="flex gap-2 items-center">
              At
              <Field name="hour">
                {({ value, onChange }) => (
                  <Select value={value} onChange={(v) => onChange(parseInt(v))} options={hourOptions} />
                )}
              </Field>
              :
              <Field name="minute">
                {({ value, onChange }) => (
                  <Select value={value} onChange={(v) => onChange(parseInt(v))} options={minuteOptions} />
                )}
              </Field>
            </div>
          </div>
        )}
      </Field>
      <Group name="payload">
        <Field name={'sceneId'} label="Open scene">
          <Select options={scenesAsOptions} />
        </Field>
        {event.payload.sceneId ? (
          <Group name="state">
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
          </Group>
        ) : null}
      </Group>
      <Field name="disabled">
        {({ value, onChange }) => <Switch label="Enabled" checked={!value} onChange={(v) => onChange(!v)} />}
      </Field>
      <div className="flex gap-2">
        <div className="@md:w-1/3 hidden @md:block" />
        <div className="flex gap-2 w-full">
          <Button
            color="primary"
            onClick={(e) => {
              e.stopPropagation()
              closeEvent(event.id)
            }}
          >
            Save
          </Button>
          <Button
            color="secondary"
            onClick={(e) => {
              e.stopPropagation()
              deleteEvent(event.id)
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </>
  )
}

export function Schedule() {
  const { frameId } = useValues(frameLogic)
  const { sendEvent } = useActions(frameLogic)
  const { editingEvents, sortedEvents, scenesAsOptions, fieldsForScene, expandedDescriptions, sort, disabled } =
    useValues(scheduleLogic({ frameId }))
  const { editEvent, addEvent, closeEvent, deleteEvent, toggleDescription, setSort } = useActions(
    scheduleLogic({ frameId })
  )
  return (
    <div className="space-y-2">
      <Form logic={frameLogic} formKey="frameForm" className="space-y-2">
        <div className="flex w-full items-center justify-between">
          <Field name={['schedule', 'disabled']}>
            {({ value, onChange }) => (
              <Switch label="Enable schedule" checked={!value} onChange={(v) => onChange(!v)} />
            )}
          </Field>
          <Select
            options={[
              { label: 'Sory by day', value: 'day' },
              { label: 'Sory by hour', value: 'hour' },
              { label: 'Sory by scene', value: 'scene' },
            ]}
            value={sort}
            onChange={setSort}
          />
        </div>
        {sortedEvents.map((event, index) => (
          <div
            className={clsx(
              'bg-gray-900 p-2 space-y-2 @container',
              !editingEvents[event.id] && (event.disabled || disabled) ? 'opacity-50' : ''
            )}
            key={event.id}
          >
            {editingEvents[event.id] ? (
              <Group name={['schedule', 'events', index]}>
                <EditRow
                  key={event.id}
                  event={event}
                  scenesAsOptions={scenesAsOptions}
                  eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                  closeEvent={closeEvent}
                  deleteEvent={deleteEvent}
                />
              </Group>
            ) : (
              <ViewRow
                key={event.id}
                disabled={disabled}
                event={event}
                scenesAsOptions={scenesAsOptions}
                eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                expandedDescription={expandedDescriptions[event.id] ?? false}
                toggleDescription={toggleDescription}
                editEvent={editEvent}
                sendEvent={sendEvent}
              />
            )}
          </div>
        ))}
      </Form>
      <Button onClick={() => addEvent()} size="small" className="flex gap-1 items-center">
        <PlusIcon className="w-5 h-5" />
        Add another entry
      </Button>
    </div>
  )
}
