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
import { NumberTextInput } from '../../components/NumberTextInput'
import { Switch } from '../../components/Switch'

export function Settings() {
  const {
    settings,
    savedSettings,
    savedSettingsLoading,
    settingsChanged,
    customFontsLoading,
    isCustomFontsFormSubmitting,
    customFonts,
  } = useValues(settingsLogic)
  const { submitSettings, newKey, newNixKey, deleteCustomFont } = useActions(settingsLogic)
  const { isHassioIngress } = useValues(sceneLogic)
  const { logout } = useActions(sceneLogic)

  return (
    <div className="h-full w-full overflow-hidden max-w-screen max-h-screen left-0 top-0 absolute">
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
        <div className="h-full w-full overflow-y-auto p-4 @container">
          {savedSettingsLoading ? (
            <Spinner />
          ) : (
            <>
              <Form logic={settingsLogic} formKey="settings" props={{}} onSubmit={submitSettings} className="space-y-4">
                <Group name="frameOS">
                  <H6 className="pt-4">FrameOS Gallery</H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">
                      <a className="text-blue-400 hover:underline" target="_blank" href="https://gallery.frameos.net/">
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
                <Group name="openAI">
                  <H6 className="pt-4">OpenAI</H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">The OpenAI API key is used within OpenAI apps.</p>
                    <Field name="apiKey" label="API key" secret={!!savedSettings?.openAI?.apiKey}>
                      <TextInput name="apiKey" />
                    </Field>
                  </Box>
                </Group>
                <Group name="homeAssistant">
                  <H6 className="pt-4">Home Assistant</H6>
                  <Box className="p-2 space-y-2">
                    <Field name="url" label="Home assistant URL">
                      <TextInput placeholder="http://homeassistant.local:8123" />
                    </Field>
                    <Field
                      name="accessToken"
                      label="Access token (Profile -> Long-Lived Access Tokens)"
                      secret={!!savedSettings?.homeAssistant?.accessToken}
                    >
                      <TextInput />
                    </Field>
                  </Box>
                </Group>
                <Group name="github">
                  <H6 className="pt-4">Github</H6>
                  <Box className="p-2 space-y-2">
                    <Field name="api_key" label="API key" secret={!!savedSettings?.github?.api_key}>
                      <TextInput />
                    </Field>
                  </Box>
                </Group>
                <Group name="unsplash">
                  <H6 className="pt-4">Unsplash API</H6>
                  <Box className="p-2 space-y-2">
                    <Field name="accessKey" label="Access key" secret={!!savedSettings?.unsplash?.accessKey}>
                      <TextInput />
                    </Field>
                  </Box>
                </Group>
                <Group name="nix">
                  <H6 className="pt-4">Nix settings</H6>
                  <Box className="p-2 space-y-2">
                    <Field name="buildExtraArgs" label="Extra args to build commands">
                      <TextInput placeholder="-j0" />
                    </Field>
                    <Field
                      name="buildServerEnabled"
                      label="Enable remote build server"
                      tooltip="These settings are used to build frames on a remote server. If you don't have a remote build
                      server, you can leave these fields empty."
                    >
                      {({ value, onChange }) => (
                        <div className="w-full">
                          <Switch value={value} onChange={onChange} />
                        </div>
                      )}
                    </Field>
                    {settings?.nix?.buildServerEnabled ? (
                      <>
                        <Field name="buildServer" label="Build server address">
                          <TextInput placeholder="build.frameos.net" />
                        </Field>
                        <Field name="buildServerPort" label="Build server port">
                          <NumberTextInput placeholder="22" />
                        </Field>
                        <Field name="buildServerMaxParallelJobs" label="Max parallel jobs on build server">
                          <NumberTextInput placeholder="8" />
                        </Field>
                        <Field name="buildServerUser" label="Build server user">
                          <TextInput placeholder="frameos" />
                        </Field>
                        <Field
                          name="buildServerPrivateKey"
                          label="Build server private key"
                          secret={!!savedSettings?.nix?.buildServerPrivateKey}
                        >
                          <TextArea />
                        </Field>
                        <Field
                          name="buildServerPublicKey"
                          label="Build server public key"
                          secret={!!savedSettings?.nix?.buildServerPublicKey}
                        >
                          <TextArea />
                        </Field>
                        <Button
                          onClick={newNixKey}
                          color={savedSettings?.ssh_keys?.default ? 'secondary' : 'primary'}
                          size="small"
                        >
                          Generate new keypair
                        </Button>
                      </>
                    ) : null}
                  </Box>
                </Group>
                <Group name="ssh_keys">
                  <H6 className="pt-4">SSH Keys</H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">
                      This SSH key will be used on all frames that don't have a password set for SSH.
                    </p>
                    <Field name="default" label="Default private SSH key" secret={!!savedSettings?.ssh_keys?.default}>
                      <TextArea />
                    </Field>
                    <Field
                      name="default_public"
                      label="Default public SSH key (use this in the RPi Imager)"
                      secret={!!savedSettings?.ssh_keys?.default_public}
                    >
                      <TextArea />
                    </Field>
                    <Button
                      onClick={newKey}
                      color={savedSettings?.ssh_keys?.default ? 'secondary' : 'primary'}
                      size="small"
                    >
                      Generate new keypair
                    </Button>
                  </Box>
                </Group>
              </Form>
              <div className="space-y-4 mt-4">
                <H6 className="pt-4">Custom fonts</H6>
                <Box className="p-2 space-y-2">
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default Settings
