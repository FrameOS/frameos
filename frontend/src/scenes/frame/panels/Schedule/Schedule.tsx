import { Form, Group } from 'kea-forms'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Field } from '../../../../components/Field'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { useActions, useValues } from 'kea'
import { scheduleLogic } from './scheduleLogic'
import { PencilSquareIcon } from '@heroicons/react/24/outline'
import { PlusIcon } from '@heroicons/react/24/solid'
import { StateFieldEdit } from '../Scenes/StateFieldEdit'
import { ScheduledEvent, StateField } from '../../../../types'

const weekDayOptions = [
  { value: '', label: 'Every day' },
  { value: '7', label: 'Every weekday' },
  { value: '8', label: 'Every weekend' },
  { value: '1', label: 'Mondays' },
  { value: '2', label: 'Tuesdays' },
  { value: '3', label: 'Wednesdays' },
  { value: '4', label: 'Thursdays' },
  { value: '5', label: 'Fridays' },
  { value: '6', label: 'Saturdays' },
  { value: '0', label: 'Sundays' },
]
const weekDays = Object.fromEntries(weekDayOptions.map((option) => [option.value, option.label]))

const hourOptions = [...Array(24).keys()].map((hour) => ({
  value: hour.toString(),
  label: hour < 10 ? `0${hour}` : hour.toString(),
}))
const minuteOptions = [...Array(60).keys()].map((minute) => ({
  value: minute.toString(),
  label: minute < 10 ? `0${minute}` : minute.toString(),
}))

interface ViewRowProps {
  event: ScheduledEvent
  scenesAsOptions: { label: string; value: string }[]
  eventFields: StateField[]
  expandedDescription: boolean
  toggleDescription: (id: string) => void
  editEvent: (id: string) => void
}

function ViewRow({
  event,
  scenesAsOptions,
  eventFields,
  expandedDescription,
  editEvent,
  toggleDescription,
}: ViewRowProps) {
  const publicFields = eventFields.filter((field) => field.access === 'public')
  const modifiedFields = publicFields.filter(
    (field) => field.name in event.payload.state && event.payload.state[field.name] !== field.value
  )
  const showToggle = publicFields.length != modifiedFields.length

  return (
    <div key={event.id} className="flex justify-between items-start">
      <div className="space-y-2">
        <div>
          {weekDays[event.weekday ?? '']} at {parseInt(event.hour) < 10 ? '0' : ''}
          {event.hour}:{parseInt(event.minute) < 10 ? '0' : ''}
          {event.minute}
        </div>

        <div
          className={showToggle ? 'font-bold cursor-pointer space-x-1' : 'font-bold space-x-2'}
          onClick={() => toggleDescription(event.id)}
        >
          <span>
            {scenesAsOptions.find((scene) => scene.value === event.payload.sceneId)?.label || 'Unspecified Scene'}
          </span>
          {showToggle ? (
            <span className="text-xs font-normal text-gray-500">({expandedDescription ? 'hide' : 'expand'})</span>
          ) : null}
        </div>
        {(expandedDescription ? publicFields : modifiedFields).map((field) => (
          <div key={field.name}>
            {field.label || field.name}: {event.payload.state[field.name] ?? field.value}
          </div>
        ))}
      </div>
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
      <Field name="weekday" label="The time">
        {({ value, onChange }) => (
          <div className="w-full space-y-2">
            <Select options={weekDayOptions} value={value} onChange={onChange} />
            <div className="flex gap-2 items-center">
              At
              <Field name="hour">
                <Select options={hourOptions} />
              </Field>
              :
              <Field name="minute">
                <Select options={minuteOptions} />
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
  const { editingEvents, events, scenesAsOptions, fieldsForScene, expandedDescriptions } = useValues(
    scheduleLogic({ frameId })
  )
  const { editEvent, addEvent, closeEvent, deleteEvent, toggleDescription } = useActions(scheduleLogic({ frameId }))
  return (
    <div className="space-y-2">
      <H6>Schedule</H6>
      <Form logic={frameLogic} formKey="frameForm" className=" space-y-2">
        {events.map((event, index) => (
          <div className="bg-gray-900 p-2 space-y-2 @container" key={event.id}>
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
                event={event}
                scenesAsOptions={scenesAsOptions}
                eventFields={fieldsForScene[event.payload.sceneId] ?? []}
                expandedDescription={expandedDescriptions[event.id] ?? false}
                toggleDescription={toggleDescription}
                editEvent={editEvent}
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
