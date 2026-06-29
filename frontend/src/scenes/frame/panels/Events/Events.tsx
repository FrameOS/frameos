import { useActions, useValues } from 'kea'
import { Form, Group } from 'kea-forms'
import { Box } from '../../../../components/Box'
import { Button } from '../../../../components/Button'
import { Field } from '../../../../components/Field'
import { H6 } from '../../../../components/H6'

import { eventsLogic } from './eventsLogic'
import { Tabs } from '../../../../components/panels/Tabs'
import { Tab } from '../../../../components/panels/Tab'
import { TextArea } from '../../../../components/TextArea'
import { TextInput } from '../../../../components/TextInput'
import { FieldDefinitionForm } from '../Fields/FieldDefinitionForm'
import { frameLogic } from '../../frameLogic'
import { AppConfigField } from '../../../../types'
import { PlusIcon } from '@heroicons/react/24/outline'

export interface EventsProps {
  frameId: number
  sceneId: string | null
}

function fieldsSummary(fields?: AppConfigField[]): string {
  return fields && fields.length > 0 ? ` {${fields.map((field) => `${field.name}: ${field.type}`).join(', ')}}` : ''
}

export function Events({ frameId, sceneId }: EventsProps) {
  const logic = eventsLogic({ frameId, sceneId })
  const {
    tab,
    events,
    search,
    tabCounts,
    scene,
    sceneIndex,
    customEventRows,
    editingCustomEvents,
    editingCustomEventFields,
    customEventsWithErrors,
    customEventFieldsWithErrors,
  } = useValues(logic)
  const {
    showDispatch,
    showListen,
    showCustom,
    setSearch,
    addCustomEvent,
    editCustomEvent,
    closeCustomEvent,
    removeCustomEvent,
    setCustomEventFields,
    addCustomEventField,
    editCustomEventField,
    closeCustomEventField,
    removeCustomEventField,
  } = useActions(logic)

  const onDragStart = (event: any, type: 'event' | 'dispatch', keyword: string) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type, keyword }))
    event.dataTransfer.effectAllowed = 'move'
  }

  if (!scene || !sceneId) {
    return <div className="frame-tool-muted">Select a scene first.</div>
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="space-y-2">
          <TextInput placeholder="Search events..." onChange={setSearch} value={search} />
          <Tabs className="frameos-divider border border-t-0 border-l-0 border-r-0 border-b-1 pl-2">
            <Tab
              onClick={showListen}
              active={tab === 'listen'}
              activeColorClass="frameos-primary-active"
              className="mb-[-1px]"
            >
              Listen ({tabCounts.listen})
            </Tab>
            <Tab
              onClick={showDispatch}
              active={tab === 'dispatch'}
              activeColorClass="frameos-primary-active"
              className="mb-[-1px]"
            >
              Dispatch ({tabCounts.dispatch})
            </Tab>
            <Tab
              onClick={showCustom}
              active={tab === 'custom'}
              activeColorClass="frameos-primary-active"
              className="mb-[-1px]"
            >
              Custom ({tabCounts.custom})
            </Tab>
          </Tabs>

          {tab === 'custom' ? (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button onClick={() => addCustomEvent()} size="small" color="secondary" className="inline-flex gap-1">
                  <PlusIcon className="h-4 w-4" />
                  Add event
                </Button>
              </div>
              {customEventRows.map(({ event, index }) => (
                <Group name={['customEvents', index]} key={index}>
                  {customEventsWithErrors[index] ? (
                    <div className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-400">
                      <p>There are errors with this event. Please fix them to save.</p>
                    </div>
                  ) : null}
                  {editingCustomEvents[index] ? (
                    <div className="frame-tool-card space-y-4 rounded-2xl p-4">
                      <Field name="name" label="Event name">
                        <TextInput placeholder="e.g. imageSelected" />
                      </Field>
                      <Field name="description" label="Description">
                        <TextArea placeholder="When an image is selected" rows={2} />
                      </Field>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <H6>Payload fields</H6>
                          <div className="frame-tool-muted text-sm">
                            These fields become the fixed payload for dispatching and listening to this event.
                          </div>
                        </div>
                        <Button
                          onClick={() => addCustomEventField(index)}
                          size="small"
                          color="secondary"
                          className="inline-flex shrink-0 gap-1"
                        >
                          <PlusIcon className="h-4 w-4" />
                          Add field
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {(event.fields ?? []).map((field, fieldIndex) => (
                          <Group name={['fields', fieldIndex]} key={fieldIndex}>
                            {customEventFieldsWithErrors[`${index}:${fieldIndex}`] ? (
                              <div className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-400">
                                <p>There are errors with this field. Please fix them to save.</p>
                              </div>
                            ) : null}
                            {editingCustomEventFields[`${index}:${fieldIndex}`] ? (
                              <FieldDefinitionForm
                                field={field}
                                fields={event.fields ?? []}
                                index={fieldIndex}
                                setFields={(fields) => setCustomEventFields(index, fields)}
                                closeField={(fieldIndex) => closeCustomEventField(index, fieldIndex)}
                                removeField={(fieldIndex) => removeCustomEventField(index, fieldIndex)}
                                removeLabel="Remove field"
                              />
                            ) : (
                              <div className="frame-tool-row rounded-xl p-3">
                                <div className="flex w-full min-w-0 items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate font-semibold">
                                      {field.label || field.name || 'Unnamed field'}
                                    </div>
                                    <div className="frame-tool-muted truncate text-sm">
                                      {field.name || 'no codename'}: {field.type}
                                    </div>
                                  </div>
                                  <Button
                                    onClick={() => editCustomEventField(index, fieldIndex)}
                                    size="small"
                                    color="secondary"
                                  >
                                    Edit
                                  </Button>
                                </div>
                              </div>
                            )}
                          </Group>
                        ))}
                        {(event.fields ?? []).length === 0 ? (
                          <div className="frame-tool-muted rounded-xl border border-dashed border-slate-300/70 p-3 text-sm">
                            No payload fields.
                          </div>
                        ) : null}
                      </div>
                      <div className="flex w-full items-center justify-between gap-2">
                        <Button
                          onClick={() => closeCustomEvent(index)}
                          disabled={!event.name?.trim()}
                          color="secondary"
                          size="small"
                        >
                          Save & Close
                        </Button>
                        <Button onClick={() => removeCustomEvent(index)} size="small" color="secondary">
                          <span className="text-red-300">Remove event</span>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Box className="frame-tool-row flex items-stretch gap-3 py-2 pl-0.5 pr-3">
                      <div className="min-w-0 flex-1 pl-3">
                        <div className="flex w-full items-center justify-between gap-2">
                          <H6>{event.name || 'Unnamed event'}</H6>
                          <div className="flex shrink-0 gap-1">
                            <Button onClick={() => editCustomEvent(index)} size="small" color="secondary">
                              Edit
                            </Button>
                            <Button onClick={() => removeCustomEvent(index)} size="small" color="secondary">
                              <span className="text-red-300">Remove</span>
                            </Button>
                          </div>
                        </div>
                        <div className="text-sm">
                          {event.description}
                          {fieldsSummary(event.fields)}
                        </div>
                      </div>
                    </Box>
                  )}
                </Group>
              ))}
              {customEventRows.length === 0 ? (
                search === '' ? (
                  <div>No custom events yet</div>
                ) : (
                  <div>No custom events found for "{search}"</div>
                )
              ) : null}
            </div>
          ) : (
            <>
              {events
                .toSorted((a, b) => a.name.localeCompare(b.name))
                .map(({ name, description, fields }) => (
                  <Box
                    key={name}
                    className="frame-tool-row dndnode flex cursor-move items-stretch gap-3 py-2 pl-0.5 pr-3"
                    draggable
                    onDragStart={(event) => onDragStart(event, tab === 'listen' ? 'event' : 'dispatch', name)}
                  >
                    <div className="frame-tool-drag-handle" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex w-full items-center justify-between">
                        <H6>{name}</H6>
                      </div>
                      <div className="text-sm">
                        {description}
                        {fieldsSummary(fields)}
                      </div>
                    </div>
                  </Box>
                ))}
              {events.length === 0 ? (
                search === '' ? (
                  <div>No events found</div>
                ) : (
                  <div>No events found for "{search}"</div>
                )
              ) : null}
            </>
          )}
        </div>
      </Group>
    </Form>
  )
}
