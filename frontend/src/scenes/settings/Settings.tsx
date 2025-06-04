import { useActions, useValues } from 'kea'
import { Form, Group } from 'kea-forms'
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
import { Masonry } from '../../components/Masonry'
import { TrashIcon } from '@heroicons/react/24/solid'

export function Settings() {
  const {
    savedSettings,
    savedSettingsLoading,
    settingsChanged,
    customFontsLoading,
    isCustomFontsFormSubmitting,
    customFonts,
  } = useValues(settingsLogic)
  const { submitSettings, newKey, deleteCustomFont } = useActions(settingsLogic)
  const { isHassioIngress } = useValues(sceneLogic)
  const { logout } = useActions(sceneLogic)

  return (
    <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
      <div className="flex flex-col h-full max-h-full">
        <div className="h-[60px]">
          <Header
            title="Settings"
            right={
              <div className="flex gap-2">
                {!isHassioIngress ? <Button onClick={logout}>Logout</Button> : null}
                <Button color={settingsChanged ? 'primary' : 'secondary'} onClick={submitSettings}>
                  Save
                </Button>
              </div>
            }
          />
        </div>
        <div
          // id="frames"
          className="h-full"
        >
          {savedSettingsLoading ? (
            <Spinner />
          ) : (
            <Masonry id="frames" className="p-4">
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
                    <Field
                      name="accessToken"
                      label="Access token (Profile -> Long-Lived Access Tokens)"
                      secret={!!savedSettings?.homeAssistant?.accessToken}
                    >
                      <TextInput autoFocus={!!savedSettings?.homeAssistant?.accessToken} />
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
                <Group name="unsplash">
                  <Box className="p-2 mb-4 space-y-2">
                    <H6>Unsplash API</H6>
                    <Field name="accessKey" label="Access key" secret={!!savedSettings?.unsplash?.accessKey}>
                      <TextInput autoFocus={!!savedSettings?.unsplash?.accessKey} />
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
              <Box className="p-2 mb-4 space-y-2">
                <H6>Custom fonts</H6>
                <p className="text-sm leading-loose">
                  These fonts will be uploaded to all frames and can be used in the FrameOS editor.
                </p>
                <div className="space-y-1">
                  {customFonts.map((font) => (
                    <div key={font.id} className="flex items-center gap-2">
                      <div className="flex-1">{font.path.substring(6)}</div>
                      <Button size="tiny" color="secondary" onClick={() => deleteCustomFont(font)}>
                        <TrashIcon className="w-5 h-5" />
                      </Button>
                    </div>
                  ))}
                </div>
                {customFontsLoading || isCustomFontsFormSubmitting ? <Spinner /> : <div className="flex gap-2"></div>}
                <Form logic={settingsLogic} formKey="customFontsForm" enableFormOnSubmit className="space-y-2">
                  <Field label="" name="files">
                    {({ onChange }) => (
                      <input
                        type="file"
                        accept=".ttf"
                        multiple
                        className="w-full"
                        onChange={(e: React.FormEvent<HTMLInputElement>) => {
                          const target = e.target as HTMLInputElement & {
                            files: FileList
                          }
                          onChange(target.files)
                        }}
                      />
                    )}
                  </Field>
                  <div className="flex gap-2">
                    <Button type="submit" size="small" color="primary">
                      Upload fonts
                    </Button>
                  </div>
                </Form>
              </Box>
            </Masonry>
          )}
        </div>
      </div>
    </div>
  )
}

export default Settings
