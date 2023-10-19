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

export function Settings() {
  const { savedSettings, savedSettingsLoading, settingsChanged } = useValues(settingsLogic)
  const { submitSettings } = useActions(settingsLogic)
  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <PanelGroup direction="vertical" units="pixels">
        <Panel minSize={60} maxSize={60}>
          <Header
            title="FrameOS"
            subtitle="Settings"
            right={
              <Button color={settingsChanged ? 'teal' : 'light-gray'} onClick={submitSettings}>
                Save
              </Button>
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
                <Group name="openai">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>OpenAI</H6>
                    <Field name="api_key" label="API key" secret={!!savedSettings?.openai?.api_key}>
                      <TextInput name="api_key" autoFocus={!!savedSettings?.openai?.api_key} />
                    </Field>
                  </Box>
                </Group>
                <Group name="home_assistant">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Home Assistant</H6>
                    <Field name="url" label="Home assistant URL">
                      <TextInput name="url" placeholder="http://homeassistant.local:8123" />
                    </Field>
                    <Field
                      name="access_token"
                      label="Access token"
                      secret={!!savedSettings?.home_assistant?.access_token}
                    >
                      <TextInput name="access_token" autoFocus={!!savedSettings?.home_assistant?.access_token} />
                    </Field>
                  </Box>
                </Group>
                <Group name="github">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Github</H6>
                    <Field name="api_key" label="API key" secret={!!savedSettings?.github?.api_key}>
                      <TextInput name="api_key" autoFocus={!!savedSettings?.github?.api_key} />
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
