import { useActions, useValues } from 'kea'
import { Form, Group } from 'kea-forms'

import { Box } from '../../components/Box'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { H6 } from '../../components/H6'
import { NumberTextInput } from '../../components/NumberTextInput'
import { Select } from '../../components/Select'
import { Switch } from '../../components/Switch'
import { TextInput } from '../../components/TextInput'
import { sceneLogic } from '../sceneLogic'
import { globalSettingsSectionIsAllowed, workspaceMode } from '../workspace/workspaceSurfaces'
import { settingsLogic } from './settingsLogic'

export function SettingsGroupDivider({ label }: { label: string }): JSX.Element {
  return (
    <div className="settings-group-divider" aria-hidden="true">
      <span>{label}</span>
    </div>
  )
}

// The "Services" part of the global settings: the API keys the apps on the
// frames use (gallery, OpenAI, Home Assistant, GitHub, Immich, Unsplash).
// One form over settingsLogic's `settings`, saved by the page's Save button.
// Self-hosted it is one group of the long settings page (with the divider);
// on the cloud it is the whole "Service keys" page.
//
// The mode's allow-list (workspaceSurfaces.ts allowedGlobalSettingsSections)
// decides which services exist; sections kept on the cloud still hide the
// fields only a self-hosted backend can act on (its own OpenAI key and model
// overrides, the Home Assistant MQTT sync bridge).
export function ServicesSettingsForm({ divider = true }: { divider?: boolean }): JSX.Element {
  const {
    settings,
    savedSettings,
    openAiModelOverridesExpanded,
    isSyncingHomeAssistant,
    homeAssistantMqttHostDefault,
  } = useValues(settingsLogic)
  const { submitSettings, syncHomeAssistant, toggleOpenAiModelOverrides } = useActions(settingsLogic)
  const { isHassioIngress } = useValues(sceneLogic)
  const mode = workspaceMode()
  const showSection = (sectionId: string): boolean => globalSettingsSectionIsAllowed(mode, sectionId)
  const showBackendOnlyFields = mode !== 'cloud'

  return (
    <>
      {divider ? <SettingsGroupDivider label="Services" /> : null}
      <Form logic={settingsLogic} formKey="settings" props={{}} onSubmit={submitSettings} className="space-y-4">
        {showSection('settings-gallery') ? (
          <Group name="frameOS">
            <H6 id="settings-gallery" className="pt-4">
              FrameOS Gallery
            </H6>
            <Box className="p-2 space-y-2">
              <p className="text-sm leading-loose">
                <a className="frameos-link hover:underline" target="_blank" href="https://gallery.frameos.net/">
                  Premium AI slop
                </a>{' '}
                to get you started.
              </p>
              <Field
                name="apiKey"
                label="API key"
                secret={!!savedSettings?.frameOS?.apiKey}
                tooltip="Just use 2024 for now. We might add custom accounts in the future"
              >
                <TextInput />
              </Field>
            </Box>
          </Group>
        ) : null}
        {showSection('settings-openai') ? (
          <Group name="openAI">
            <H6 id="settings-openai" className="pt-4">
              OpenAI
            </H6>
            <Box className="p-2 space-y-2">
              <p className="text-sm leading-loose">
                The OpenAI API key is used within OpenAI apps on frames.
                {showBackendOnlyFields
                  ? ' The backend key powers AI features in the control plane.'
                  : ' The AI chat key powers scene chat here in the workspace; it stays on your account and is never sent to frames.'}
              </p>
              <Field name="apiKey" label="API key for frames" secret={!!savedSettings?.openAI?.apiKey}>
                <TextInput name="apiKey" />
              </Field>
              {!showBackendOnlyFields ? (
                <>
                  <Field
                    name="backendApiKey"
                    label="API key for AI chat"
                    secret={!!savedSettings?.openAI?.backendApiKey}
                  >
                    <TextInput name="backendApiKey" />
                  </Field>
                  {/* Both were API-only (POST /api/settings accepted
                      them, nothing rendered them), so the only way to
                      try a different model was curl. Folded behind the
                      same disclosure the backend uses: the defaults
                      are right for almost everyone. */}
                  <div className="pt-1">
                    <Button size="small" color="secondary" onClick={toggleOpenAiModelOverrides}>
                      {openAiModelOverridesExpanded ? 'Hide model settings' : 'Show model settings'}
                    </Button>
                  </div>
                  {openAiModelOverridesExpanded ? (
                    <div className="space-y-2 border-t border-slate-500/20 pt-3">
                      <Field
                        name="chatModel"
                        label="Chat model"
                        tooltip="OpenAI model the workspace chat runs on. Leave empty for the default."
                      >
                        <TextInput name="chatModel" placeholder="gpt-5.6-terra" />
                      </Field>
                      <Field
                        name="chatReasoningEffort"
                        label="Reasoning effort"
                        tooltip="How much the model thinks before answering. Higher is slower and costs more; it mostly pays off on complex scene builds. Ignored by models without reasoning."
                      >
                        {({ value, onChange }) => (
                          <Select
                            value={typeof value === 'string' ? value : ''}
                            onChange={onChange}
                            options={[
                              { value: '', label: 'Default (low)' },
                              { value: 'minimal', label: 'Minimal' },
                              { value: 'low', label: 'Low' },
                              { value: 'medium', label: 'Medium' },
                              { value: 'high', label: 'High' },
                            ]}
                          />
                        )}
                      </Field>
                    </div>
                  ) : null}
                </>
              ) : null}
              {showBackendOnlyFields ? (
                <>
                  <Field
                    name="backendApiKey"
                    label="API key for backend"
                    secret={!!savedSettings?.openAI?.backendApiKey}
                  >
                    <TextInput name="backendApiKey" />
                  </Field>
                  <Field name="model" label="Model">
                    <TextInput name="model" placeholder="gpt-5.5" />
                  </Field>
                  <div className="pt-1">
                    <Button size="small" color="secondary" onClick={toggleOpenAiModelOverrides}>
                      {openAiModelOverridesExpanded ? 'Hide model overrides' : 'Show model overrides'}
                    </Button>
                  </div>
                </>
              ) : null}
              {showBackendOnlyFields && openAiModelOverridesExpanded ? (
                <div className="space-y-2 border-t border-slate-500/20 pt-3">
                  <Field name="chatModel" label="Chat model">
                    <TextInput name="chatModel" placeholder="Use shared model" />
                  </Field>
                  <Field
                    name="chatReasoningEffort"
                    label="Chat reasoning effort"
                    tooltip="How much the AI chat's model thinks before answering. Higher is slower and costs more; it mostly pays off on complex scene builds. Ignored by models without reasoning."
                  >
                    {({ value, onChange }) => (
                      <Select
                        value={typeof value === 'string' ? value : ''}
                        onChange={onChange}
                        options={[
                          { value: '', label: 'Default (low)' },
                          { value: 'minimal', label: 'Minimal' },
                          { value: 'low', label: 'Low' },
                          { value: 'medium', label: 'Medium' },
                          { value: 'high', label: 'High' },
                        ]}
                      />
                    )}
                  </Field>
                  <Field name="sceneModel" label="Scene generation model">
                    <TextInput name="sceneModel" placeholder="Use shared model" />
                  </Field>
                  <Field name="reviewModel" label="Scene review model">
                    <TextInput name="reviewModel" placeholder="Use shared model" />
                  </Field>
                  <Field name="appChatModel" label="App chat model">
                    <TextInput name="appChatModel" placeholder="Use shared model" />
                  </Field>
                  <Field name="appEditModel" label="App edit chat model">
                    <TextInput name="appEditModel" placeholder="Use shared model" />
                  </Field>
                </div>
              ) : null}
            </Box>
          </Group>
        ) : null}
        {showSection('settings-posthog') ? (
          <Group name="posthog">
            <H6 id="settings-posthog" className="pt-4">
              PostHog
            </H6>
            <Box className="p-2 space-y-2">
              <Field name="backendApiKey" label="Backend API key" secret={!!savedSettings?.posthog?.backendApiKey}>
                <TextInput />
              </Field>
              <Field name="backendHost" label="Backend host">
                <TextInput placeholder="https://us.i.posthog.com" />
              </Field>
              <Field name="backendEnableErrorTracking" label="Backend - enable error tracking">
                <Switch fullWidth />
              </Field>
              <Field name="backendEnableLlmAnalytics" label="Backend - enable llm analytics">
                <Switch fullWidth />
              </Field>
            </Box>
          </Group>
        ) : null}
        {showSection('settings-home-assistant') ? (
          <Group name="homeAssistant">
            <H6 id="settings-home-assistant" className="pt-4">
              Home Assistant
            </H6>
            <Box className="p-2 space-y-2">
              <Field name="url" label="Home assistant URL">
                <TextInput placeholder="http://homeassistant.local:8123" />
              </Field>
              <Field
                name="accessToken"
                label="Access token (Profile → Long-Lived Access Tokens)"
                secret={!!savedSettings?.homeAssistant?.accessToken}
              >
                <TextInput />
              </Field>
              {showBackendOnlyFields ? (
                <div className="space-y-2 border-t border-slate-500/20 pt-3">
                  <Field
                    name="syncEnabled"
                    label="Share frames with Home Assistant"
                    tooltip={
                      <>
                        Each frame becomes a device with a live image and status/scene sensors (via MQTT discovery), and
                        frame events are forwarded to the Home Assistant event bus as <code>frameos_event</code> for use
                        in automations. Archived frames are not shared.
                      </>
                    }
                  >
                    <Switch fullWidth />
                  </Field>
                  {isHassioIngress ? (
                    <p className="frameos-muted text-sm leading-loose">
                      Running as a Home Assistant add-on: the Home Assistant connection and the MQTT broker (Mosquitto
                      add-on) are discovered automatically. The URL and access token above are only needed by Home
                      Assistant apps running on your frames.
                    </p>
                  ) : null}
                  {!isHassioIngress && settings?.homeAssistant?.syncEnabled ? (
                    <>
                      <p className="text-sm leading-loose">
                        To get an MQTT login, in Home Assistant go to Settings → Apps → Mosquitto broker → Configuration
                        → Logins → Add. Then press the Save button.
                      </p>
                      <Field name="mqttUsername" label="MQTT username">
                        <TextInput />
                      </Field>
                      <Field
                        name="mqttPassword"
                        label="MQTT password"
                        secret={!!savedSettings?.homeAssistant?.mqttPassword}
                      >
                        <TextInput />
                      </Field>
                      <Field name="mqttHost" label="MQTT host (optional)">
                        <TextInput placeholder={homeAssistantMqttHostDefault} />
                      </Field>
                      <Field name="mqttPort" label="MQTT port (optional)">
                        <NumberTextInput placeholder="1883" />
                      </Field>
                    </>
                  ) : null}
                  {settings?.homeAssistant?.syncEnabled ? (
                    <div className="pt-1">
                      <Button
                        size="small"
                        color="secondary"
                        onClick={syncHomeAssistant}
                        disabled={isSyncingHomeAssistant}
                      >
                        {isSyncingHomeAssistant ? 'Syncing...' : 'Save & sync now'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Box>
          </Group>
        ) : null}
        {showSection('settings-github') ? (
          <Group name="github">
            <H6 id="settings-github" className="pt-4">
              GitHub
            </H6>
            <Box className="p-2 space-y-2">
              <Field name="api_key" label="API key" secret={!!savedSettings?.github?.api_key}>
                <TextInput />
              </Field>
            </Box>
          </Group>
        ) : null}
        {showSection('settings-immich') ? (
          <Group name="immich">
            <H6 id="settings-immich" className="pt-4">
              Immich
            </H6>
            <Box className="p-2 space-y-2">
              <Field name="url" label="Server URL">
                <TextInput placeholder="https://immich.example.com" />
              </Field>
              <Field
                name="apiKey"
                label="API key (Account Settings → API Keys)"
                secret={!!savedSettings?.immich?.apiKey}
              >
                <TextInput />
              </Field>
            </Box>
          </Group>
        ) : null}
        {showSection('settings-unsplash') ? (
          <Group name="unsplash">
            <H6 id="settings-unsplash" className="pt-4">
              Unsplash API
            </H6>
            <Box className="p-2 space-y-2">
              <Field name="accessKey" label="Access key" secret={!!savedSettings?.unsplash?.accessKey}>
                <TextInput />
              </Field>
            </Box>
          </Group>
        ) : null}
      </Form>
    </>
  )
}
