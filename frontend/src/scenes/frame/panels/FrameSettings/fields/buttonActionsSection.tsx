import { ArrowUturnLeftIcon, PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../../components/Button'
import { H6 } from '../../../../../components/H6'
import { Label } from '../../../../../components/Label'
import { Select, type SelectOptionEntry } from '../../../../../components/Select'
import { Tag } from '../../../../../components/Tag'
import type { EventMapRule, FrameId, FrameScene } from '../../../../../types'
import {
  cloudFrameSupportsEventMap,
  eventMapCloudFrameSettingsMinVersion,
} from '../../../../../utils/cloudFrameSettings'
import {
  type ButtonBinding,
  type FrameAction,
  type FrameActionOffer,
  type FrameGesture,
  bindingConflicts,
  deviceEventMap,
  edgeGestures,
  esp32EventMapMaxBytes,
  eventMapBytes,
  frameActionKindsFor,
  frameActionTitle,
  frameActionUnavailableReason,
  frameActionValue,
  frameBindings,
  frameEventMapRules,
  frameGestureTitle,
  frameGestureValue,
  frameOffersEdgeGestures,
  frameSupportsBackForward,
  frameSupportsSceneSettings,
  frameSupportsSceneSwitcher,
  gestureCanVoiceChat,
  parseFrameActionValue,
  parseFrameGestureValue,
  reportedEventMapOf,
  showSceneStaleSettings,
  withShowSceneSetting,
} from '../../../../../utils/frameEventMap'
import { locatedValues, locationFieldPair } from '../../../../../utils/geolocation'
import { REFRESH_INTERVAL_ROLE, sceneStateFields } from '../../../../../utils/refreshInterval'
import { buttonGestures, frameButtons } from '../../../../../utils/sceneEventMap'
import { visiblePublicStateFields } from '../../../../../utils/showIf'
import { deviceSwitchesDisplay, frameDisplayDevice, isEsp32Frame } from '../../../../workspace/workspaceSurfaces'
import { StateFieldEdit } from '../../Scenes/StateFieldEdit'
import { useFrameSettings } from '../frameSettingsContext'

/**
 * A Show scene row's settings: the public fields of the scene it shows,
 * whose values the press shows it with (`setCurrentScene {sceneId, state}`,
 * applied to the scene's public state like a schedule entry's). A field left
 * alone keeps the scene's own value; a set one has a reset.
 */
function ShowSceneSettings({
  action,
  scene,
  frameId,
  disabled,
  onChange,
}: {
  action: FrameAction
  scene: FrameScene | undefined
  frameId: FrameId
  disabled: boolean
  onChange: (action: FrameAction) => void
}): JSX.Element | null {
  const state = action.state ?? {}
  const allFields = scene ? sceneStateFields(scene) : []
  const fields = visiblePublicStateFields(allFields, state)
  const stale = showSceneStaleSettings(
    action,
    allFields.filter((field) => field.access === 'public').map((field) => field.name)
  )
  if (!scene || (fields.length === 0 && stale.length === 0)) {
    return null
  }
  const location = locationFieldPair(fields)
  const clear = (names: readonly string[]): FrameAction =>
    names.reduce((next, name) => withShowSceneSetting(next, { name, type: 'string' }, undefined), action)
  return (
    <div className="space-y-2 rounded-lg border border-slate-500/20 p-3 @md:ml-4">
      <p className="frameos-muted text-xs">
        {scene.name || scene.id}&apos;s settings when this press shows it. A field left alone keeps the scene&apos;s own
        value.
      </p>
      {fields.map((field) => {
        const set = Object.prototype.hasOwnProperty.call(state, field.name)
        return (
          <div key={field.name} className="grid grid-cols-1 gap-1 @md:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_auto]">
            <Label className="flex-col !gap-0 @md:pt-2">
              <span>{field.label || field.name}</span>
              {set ? null : <span className="frameos-muted text-xs font-normal">the scene&apos;s own</span>}
            </Label>
            <div className={disabled ? 'pointer-events-none opacity-60' : undefined}>
              <StateFieldEdit
                field={field}
                value={state[field.name] as any}
                onChange={(value) => onChange(withShowSceneSetting(action, field, value))}
                currentState={{}}
                stateChanges={{}}
                frameId={frameId}
                onLocate={
                  location && field.name === location.first
                    ? (located) =>
                        onChange(
                          Object.entries(locatedValues(location, located)).reduce(
                            (next, [name, value]) =>
                              withShowSceneSetting(
                                next,
                                fields.find((candidate) => candidate.name === name) ?? { name, type: 'string' },
                                value
                              ),
                            action
                          )
                        )
                    : undefined
                }
              />
              {field.role === REFRESH_INTERVAL_ROLE ? (
                <p className="frameos-muted mt-1 text-xs">How often the scene renders from this press on.</p>
              ) : null}
            </div>
            <Button
              size="small"
              color="secondary"
              className="flex items-center gap-1 self-start"
              disabled={disabled || !set}
              title="Keep the scene's own value"
              onClick={() => onChange(clear([field.name]))}
            >
              <ArrowUturnLeftIcon className="w-4 h-4" />
              Reset
            </Button>
          </div>
        )
      })}
      {stale.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          The scene has no public {stale.length === 1 ? 'field' : 'fields'} {stale.join(', ')} any more; the frame
          ignores {stale.length === 1 ? 'it' : 'them'}.{' '}
          <button type="button" className="underline" disabled={disabled} onClick={() => onChange(clear(stale))}>
            Remove
          </button>
        </p>
      ) : null}
    </div>
  )
}

/**
 * Button actions (frame.json `eventMap`, docs/events.md "Event map"): what a
 * press of one of the frame's buttons does whatever scene is showing. A
 * press bound here never reaches the scene; "Map buttons" on an installed
 * scene is for the presses that do. A cloud frame that reported its map and
 * was never pushed one shows that map (its board preset's), with "Edit
 * actions" seeding the editable list; everything else is the editable list.
 */
export function ButtonActionsSection(): JSX.Element {
  const { frame, frameId, frameForm, setFrameFormValues, surface, voiceChat } = useFrameSettings()
  const cloudProfile = surface === 'cloudLinux' || surface === 'cloudEsp32'
  const supported = !cloudProfile || cloudFrameSupportsEventMap(frame.frameos_version)
  const buttons = frameButtons(frame, frameForm)
  const device = frameForm.device ?? frameDisplayDevice(frame)
  const frameScenes: FrameScene[] = frameForm.scenes ?? frame.scenes ?? []
  const scenes = frameScenes.map((scene) => ({ id: scene.id, name: scene.name }))
  const reported = cloudProfile ? reportedEventMapOf(frame.hardware?.eventMap) : null
  const showReported = frameForm.event_map === undefined && reported !== null
  // A frame never given a map runs its device's (a HyperPixel's edge swipes,
  // device_event_map.nim); a cloud frame reports it, a backend frame shows it here.
  // The form carries the frame's `null` as it came: not set is not a choice.
  const deviceDefault =
    !cloudProfile && (frameForm.event_map ?? null) === null && (frame.event_map ?? null) === null
      ? deviceEventMap(device)
      : null
  const rules: EventMapRule[] = frameForm.event_map ?? (cloudProfile ? [] : frame.event_map ?? deviceDefault ?? [])
  const { bindings, others } = frameBindings(rules)
  // A touch screen's rows include the swipes in from its edges.
  const touch = frameOffersEdgeGestures(frame.hardware?.touch, device, [...rules, ...(reported ?? [])])
  const gestures: FrameGesture[] = [...buttonGestures(buttons), ...(touch ? edgeGestures() : [])]
  // What this frame can do with a press: Display on / off only where the
  // device switches the panel (not e-paper), Voice chat only on a frame with a
  // microphone, and then for a long press alone, the scene switcher from the
  // FrameOS that has it.
  const offer: FrameActionOffer = {
    voiceChat: voiceChat !== null,
    displayPower: deviceSwitchesDisplay(device),
    sceneSwitcher: frameSupportsSceneSwitcher(frame.frameos_version, cloudProfile),
    sceneSettings: frameSupportsSceneSettings(frame.frameos_version, cloudProfile),
    backForward: frameSupportsBackForward(frame.frameos_version, cloudProfile),
  }
  const conflicts = bindingConflicts(bindings, offer)
  // An ESP32 keeps its map in a 1 KB slot; a Show scene's settings are what
  // fills it.
  const mapBytes = eventMapBytes(rules)
  const tooBigForEsp32 = isEsp32Frame(frame) && mapBytes > esp32EventMapMaxBytes

  const write = (next: readonly ButtonBinding[]): void => {
    setFrameFormValues({ event_map: frameEventMapRules(next, others) })
  }
  const addBinding = (): void => {
    const gesture = gestures.find(
      (candidate) => !bindings.some((b) => frameGestureValue(b.gesture) === frameGestureValue(candidate))
    ) ??
      gestures[0] ?? { label: buttons[0]?.label ?? 'A', action: 'longPress' }
    write([...bindings, { gesture, action: { kind: 'nextScene' } }])
  }
  const gestureOptions = (binding: ButtonBinding): SelectOptionEntry[] => {
    const groups = new Map<string, { value: string; label: string }[]>()
    for (const gesture of gestures) {
      const group = 'edge' in gesture ? 'Touch screen' : gesture.label
      const entry = { value: frameGestureValue(gesture), label: frameGestureTitle(gesture) }
      groups.set(group, [...(groups.get(group) ?? []), entry])
    }
    // A binding for a button this frame no longer has stays selectable, so
    // the row shows what is saved instead of silently picking the first entry.
    const value = frameGestureValue(binding.gesture)
    const stale = gestures.some((gesture) => frameGestureValue(gesture) === value)
      ? []
      : [{ value, label: `${frameGestureTitle(binding.gesture)} (not on this frame)` }]
    return [...stale, ...Array.from(groups, ([label, options]) => ({ label, options }))]
  }
  const actionOptions = (binding: ButtonBinding): SelectOptionEntry[] => [
    // A saved action the row would not offer stays selectable, named with
    // why, so the row shows what is saved instead of picking the first entry.
    ...(frameActionUnavailableReason(binding, offer)
      ? [
          {
            value: frameActionValue(binding.action),
            label: `${frameActionTitle(binding.action)} (${frameActionUnavailableReason(binding, offer)})`,
          },
        ]
      : []),
    ...frameActionKindsFor(binding.gesture, offer).map((kind) => ({
      value: frameActionValue({ kind }),
      label: frameActionTitle({ kind }),
    })),
    // On a frame with voice chat, a press or a double press shows why it
    // cannot carry it rather than leaving the entry out.
    ...(offer.voiceChat && !gestureCanVoiceChat(binding.gesture) && binding.action.kind !== 'voiceChat'
      ? [{ value: frameActionValue({ kind: 'voiceChat' }), label: 'Voice chat (long press only)', disabled: true }]
      : []),
    ...(scenes.length > 0
      ? [
          {
            label: 'Show scene',
            options: scenes.map((scene) => ({
              value: frameActionValue({ kind: 'showScene', sceneId: scene.id }),
              label: frameActionTitle({ kind: 'showScene', sceneId: scene.id }, scenes),
            })),
          },
        ]
      : []),
  ]
  const describe = (rule: EventMapRule): string =>
    `${rule.event}${rule.match ? ' ' + JSON.stringify(rule.match) : ''} ${
      rule.emit ? `emits ${rule.emit}` : 'rewritten'
    } ${JSON.stringify(rule.as)}`

  const addButton = (
    <Button
      size="small"
      color="secondary"
      onClick={addBinding}
      className="flex items-center gap-1"
      disabled={!supported}
    >
      <PlusIcon className="w-4 h-4" />
      Add action
    </Button>
  )

  return (
    <>
      <H6 id="frame-settings-button-actions" className="flex items-center gap-2">
        Button actions
        {showReported ? (
          <>
            <Tag color="gray">On the frame</Tag>
            {supported ? (
              <Button
                size="small"
                color="secondary"
                onClick={() => setFrameFormValues({ event_map: reported.map((rule) => ({ ...rule })) })}
                className="flex items-center gap-1"
              >
                <PencilSquareIcon className="w-4 h-4" />
                Edit actions
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {deviceDefault ? <Tag color="gray">Device default</Tag> : null}
            {addButton}
          </>
        )}
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {!supported ? (
          <p className="frameos-muted text-xs">
            {frame.frameos_version
              ? `Button actions need FrameOS ${eventMapCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to edit them here.`
              : `Button actions need FrameOS ${eventMapCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`}
          </p>
        ) : null}
        <p className="frameos-muted text-xs">
          What a press does on this frame, whatever scene is showing. A press bound here never reaches the scene; a
          scene&apos;s own buttons are mapped from its menu, under Map buttons.
          {touch ? ' A swipe in from an edge of the screen is bound the same way.' : ''}
          {offer.voiceChat
            ? ' Voice chat goes on a long press: the frame listens while the key is held and stops when it is let go, so a press or a double press has no end to it.'
            : ''}
        </p>
        {showReported ? (
          reported.length > 0 ? (
            <>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {frameBindings(reported).bindings.map((binding, index) => (
                  <li key={index}>
                    {frameGestureTitle(binding.gesture)}: {frameActionTitle(binding.action, scenes)}
                  </li>
                ))}
                {frameBindings(reported).others.map((rule, index) => (
                  <li key={`other-${index}`} className="font-mono text-xs">
                    {describe(rule)}
                  </li>
                ))}
              </ul>
              <p className="frameos-muted text-xs">
                The actions the frame runs with, from its board preset. Edit actions starts from this list; saving
                pushes the new list.
              </p>
            </>
          ) : (
            <p className="frameos-muted text-xs">No button actions on the frame.</p>
          )
        ) : (
          <>
            {bindings.map((binding, index) => (
              <div key={index} className="space-y-2">
                <div className="grid grid-cols-1 items-center gap-2 @md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
                  <Select
                    name={`event_map.${index}.gesture`}
                    value={frameGestureValue(binding.gesture)}
                    options={gestureOptions(binding)}
                    disabled={!supported}
                    onChange={(value) => {
                      const gesture = parseFrameGestureValue(value)
                      if (gesture) {
                        write(bindings.map((b, i) => (i === index ? { ...b, gesture } : b)))
                      }
                    }}
                  />
                  <span className="frameos-muted text-sm">does</span>
                  <Select
                    name={`event_map.${index}.action`}
                    value={frameActionValue(binding.action)}
                    options={actionOptions(binding)}
                    disabled={!supported}
                    onChange={(value) => {
                      const action = parseFrameActionValue(value)
                      if (action) {
                        write(bindings.map((b, i) => (i === index ? { ...b, action } : b)))
                      }
                    }}
                  />
                  <Button
                    color="secondary"
                    size="small"
                    className="flex items-center gap-1"
                    disabled={!supported}
                    onClick={() => write(bindings.filter((_b, i) => i !== index))}
                  >
                    <TrashIcon className="w-4 h-4" />
                    Remove
                  </Button>
                </div>
                {binding.action.kind === 'showScene' ? (
                  <ShowSceneSettings
                    action={binding.action}
                    scene={frameScenes.find((scene) => scene.id === binding.action.sceneId)}
                    frameId={frameId}
                    disabled={!supported}
                    onChange={(action) => write(bindings.map((b, i) => (i === index ? { ...b, action } : b)))}
                  />
                ) : null}
              </div>
            ))}
            {bindings.length === 0 && others.length === 0 ? (
              <p className="frameos-muted text-xs">No button actions. Every press reaches the scene.</p>
            ) : null}
            {tooBigForEsp32 ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                These actions take {mapBytes} bytes and an ESP32 holds {esp32EventMapMaxBytes}: the frame would keep its
                old actions. Set fewer settings on the Show scene actions, or bind fewer presses.
              </p>
            ) : null}
            {conflicts.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
                {conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}</li>
                ))}
              </ul>
            ) : null}
            {others.length > 0 ? (
              <div className="space-y-1">
                <p className="frameos-muted text-xs">Rules written by hand, kept as they are:</p>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {others.map((rule, index) => (
                    <li key={index}>{describe(rule)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {buttons.length === 0 && !touch ? (
              <p className="frameos-muted text-xs">
                This frame has no buttons yet; add them under GPIO buttons and the presses appear here.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
