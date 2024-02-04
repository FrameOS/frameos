import { useActions, useValues } from 'kea'
import { Form, Group } from 'kea-forms'
import { Panel, PanelGroup } from 'react-resizable-panels'
import { Header } from '../../components/Header'
import { Box } from '../../components/Box'
import { settingsLogic } from './settingsLogic'
import { Spinner } from '../../components/Spinner'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { TextArea } from '../../components/TextArea'
import { sceneLogic } from '../sceneLogic'

export function Settings() {
  const { savedSettings, savedSettingsLoading, settingsChanged } = useValues(settingsLogic)
  const { submitSettings, newKey } = useActions(settingsLogic)
  const { logout } = useActions(sceneLogic)

  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header
            title="Settings"
            right={
              <div className="flex gap-2">
                <Button onClick={logout}>Logout</Button>
                <Button color={settingsChanged ? 'primary' : 'secondary'} onClick={submitSettings}>
                  Save
                </Button>
              </div>
            }
          />
        </Panel>
        {savedSettingsLoading ? (
          <Spinner />
        ) : (
          <Panel>
            <div
              id="frames"
              className="max-h-full overflow-auto p-4 columns-1 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-4"
            >
              <Form logic={settingsLogic} formKey="settings" props={{}} onSubmit={submitSettings}>
                <Group name="frameOS">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>FrameOS Gallery</H6>
                    <p>
                      Sign up to the premium{' '}
                      <a className="text-blue-400 hover:underline" target="_blank" href="https://gallery.frameos.net/">
                        FrameOS galleries
                      </a>{' '}
                      and support this project.
                    </p>
                    <Field name="apiKey" label="API key" secret={!!savedSettings?.frameOS?.apiKey}>
                      <TextInput autoFocus={!!savedSettings?.frameOS?.apiKey} />
                    </Field>
                  </Box>
                </Group>
                <Group name="openAI">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>OpenAI</H6>
                    The OpenAI API key is used within OpenAI apps, and for GPT4 coding assistance.
                    <Field name="apiKey" label="API key" secret={!!savedSettings?.openAI?.apiKey}>
                      <TextInput name="apiKey" autoFocus={!!savedSettings?.openAI?.apiKey} />
                    </Field>
                  </Box>
                </Group>
                <Group name="homeAssistant">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Home Assistant</H6>
                    <Field name="url" label="Home assistant URL">
                      <TextInput placeholder="http://homeassistant.local:8123" />
                    </Field>
                    <Field name="accessToken" label="Access token" secret={!!savedSettings?.homeAssistant?.accessToken}>
                      <TextInput autoFocus={!!savedSettings?.homeAssistant?.accessToken} />
                    </Field>
                  </Box>
                </Group>
                <Group name="sentry">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Sentry</H6>
                    <p>Enable Sentry to monitor track errors and exceptions</p>
                    <Field name="controller_dsn" label="Controller DSN">
                      <TextInput autoFocus={!!savedSettings?.sentry?.controller_dsn} />
                    </Field>
                    <Field name="frame_dsn" label="Frame DSN">
                      <TextInput autoFocus={!!savedSettings?.sentry?.frame_dsn} />
                    </Field>
                  </Box>
                </Group>
                <Group name="github">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Github</H6>
                    <Field name="api_key" label="API key" secret={!!savedSettings?.github?.api_key}>
                      <TextInput autoFocus={!!savedSettings?.github?.api_key} />
                    </Field>
                  </Box>
                </Group>
                <Group name="ssh_keys">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>SSH Keys</H6>
                    <p className="text-sm leading-loose">
                      This SSH key will be used on all frames that don't have a password set for SSH.
                    </p>
                    <Button
                      onClick={newKey}
                      color={savedSettings?.ssh_keys?.default ? 'secondary' : 'primary'}
                      size="small"
                    >
                      Generate new keypair
                    </Button>
                    <Field name="default" label="Default private SSH key" secret={!!savedSettings?.ssh_keys?.default}>
                      <TextArea autoFocus={!!savedSettings?.ssh_keys?.default} />
                    </Field>
                    <Field name="default_public" label="Default public SSH key (use this in the RPi Imager)">
                      <TextArea autoFocus={!!savedSettings?.ssh_keys?.default_public} />
                    </Field>
                  </Box>
                </Group>
              </Form>
            </div>
          </Panel>
        )}
      </PanelGroup>
    </div>
  )
}

export default Settings
