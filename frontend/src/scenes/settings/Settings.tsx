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
import { ArrowPathIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { NumberTextInput } from '../../components/NumberTextInput'
import { Switch } from '../../components/Switch'
import { Select } from '../../components/Select'
import { timezoneOptions } from '../../decorators/timezones'
import { SystemInfo } from './SystemInfo'
import { normalizeSshKeys, getDefaultSshKeyIds } from '../../utils/sshKeys'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { A } from 'kea-router'
import { urls } from '../../urls'
import { Tag } from '../../components/Tag'

export function Settings() {
  const {
    settings,
    savedSettings,
    savedSettingsLoading,
    settingsChanged,
    embeddingsCount,
    embeddingsTotal,
    embeddingsMissing,
    isGeneratingEmbeddings,
    isDeletingEmbeddings,
    embeddingsPollingIntervalId,
    customFontsLoading,
    isCustomFontsFormSubmitting,
    customFonts,
    generatingSshKeyId,
    sshKeyExpandedIds,
  } = useValues(settingsLogic)
  const { framesList } = useValues(framesModel)
  const {
    submitSettings,
    addSshKey,
    generateSshKey,
    removeSshKey,
    newNixKey,
    newBuildHostKey,
    deleteCustomFont,
    setSettingsValue,
    generateMissingEmbeddings,
    deleteEmbeddings,
    loadAiEmbeddingsStatus,
    toggleSshKeyExpanded,
  } = useActions(settingsLogic)
  const { isHassioIngress } = useValues(sceneLogic)
  const { logout } = useActions(sceneLogic)
  const defaultSshKeyIds = getDefaultSshKeyIds(settings?.ssh_keys)
  const framesUsingKey = (keyId: string) =>
    framesList.filter((frame) => (frame.ssh_keys ?? defaultSshKeyIds).includes(keyId))

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
                <Group name="ssh_keys">
                  <H6 className="pt-4">SSH Keys</H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">
                      These SSH keys are available for frame access. Choose which ones should be installed on new
                      frames.
                    </p>
                    <div className="space-y-4">
                      {(settings?.ssh_keys?.keys ?? []).map((key, index) => {
                        const savedKey = normalizeSshKeys(savedSettings?.ssh_keys).keys.find(
                          (saved) => saved.id === key.id
                        )
                        const isOnlyKey = (settings?.ssh_keys?.keys ?? []).length <= 1
                        const isGenerating = generatingSshKeyId === key.id
                        const matchingFrames = framesUsingKey(key.id)
                        const isExpanded = sshKeyExpandedIds.includes(key.id)
                        const hasKey = !!(key.private || key.public)
                        const isUsedForNewFrames = key.use_for_new_frames ?? false
                        return (
                          <Box key={key.id} className="border border-white/10 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-semibold text-gray-200">
                                {key.name || `Key ${index + 1}`}
                                {isUsedForNewFrames ? (
                                  <Tag color="purple" className="ml-2">
                                    Default on new frames
                                  </Tag>
                                ) : null}
                              </div>
                              <Button
                                size="tiny"
                                color="secondary"
                                onClick={() => toggleSshKeyExpanded(key.id)}
                                className="inline-flex items-center gap-1"
                              >
                                {isExpanded ? 'Hide details' : 'Show details'}
                              </Button>
                            </div>
                            {isExpanded ? (
                              <>
                                <Field name={`keys.${index}.name`} label="Key name">
                                  <TextInput />
                                </Field>
                                <Field
                                  name={`keys.${index}.use_for_new_frames`}
                                  label="Use for new frames"
                                  tooltip="Automatically install this key on new frames."
                                >
                                  <Switch fullWidth />
                                </Field>
                                <Field
                                  name={`keys.${index}.private`}
                                  label="Private SSH key"
                                  secret={!!savedKey?.private}
                                >
                                  <TextArea />
                                </Field>
                                <Field
                                  name={`keys.${index}.public`}
                                  label="Public SSH key (use this in the RPi Imager)"
                                  secret={!!savedKey?.public}
                                >
                                  <TextArea />
                                </Field>
                                <div className="text-xs text-gray-400 space-y-1">
                                  <span className="font-semibold text-gray-300">Frames using this key:</span>
                                  {matchingFrames.length === 0 ? (
                                    <div>None.</div>
                                  ) : (
                                    <div className="flex flex-wrap gap-2">
                                      {matchingFrames.map((frame) => (
                                        <A
                                          key={frame.id}
                                          href={urls.frame(frame.id)}
                                          className="text-blue-400 hover:underline"
                                        >
                                          {frame.name || frameHost(frame)}
                                        </A>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    size="tiny"
                                    color="secondary"
                                    onClick={() => generateSshKey(key.id)}
                                    className="inline-flex items-center gap-1"
                                    disabled={isGenerating}
                                  >
                                    {isGenerating ? <Spinner className="text-white" color="white" /> : null}
                                    {hasKey ? 'Regenerate' : 'Generate'}
                                  </Button>
                                  {!isOnlyKey ? (
                                    <Button
                                      size="tiny"
                                      color="secondary"
                                      onClick={() => removeSshKey(key.id)}
                                      disabled={isOnlyKey}
                                      className="inline-flex gap-1"
                                    >
                                      <TrashIcon className="w-4 h-4" /> Delete
                                    </Button>
                                  ) : null}
                                </div>
                              </>
                            ) : null}
                          </Box>
                        )
                      })}
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={addSshKey} color="secondary" size="small" className="flex gap-1">
                        <PlusIcon className="w-4 h-4" />
                        Add key
                      </Button>
                    </div>
                  </Box>
                </Group>
                <Group name="defaults">
                  <H6 className="pt-4">NixOS defaults for new frames</H6>
                  <Box className="p-2 space-y-2">
                    <p>
                      These are all used for NixOS based frames. Raspberry Pi OS based frames set them via the RPi
                      Imager.
                    </p>
                    <Field
                      name="timezone"
                      label={
                        <>
                          Timezone
                          <Button
                            size="small"
                            color="secondary"
                            onClick={() => {
                              const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
                              setSettingsValue(['defaults', 'timezone'], timezone)
                            }}
                          >
                            Detect
                          </Button>
                        </>
                      }
                    >
                      <Select name="timezone" options={timezoneOptions} />
                    </Field>
                    <Field name="wifiSSID" label="Default WiFi SSID">
                      <TextInput name="wifiSSID" placeholder="WiFi network name" />
                    </Field>
                    <Field
                      name="wifiPassword"
                      label="Default WiFi password"
                      secret={!!savedSettings?.defaults?.wifiPassword}
                    >
                      <TextInput name="wifiPassword" placeholder="WiFi password" />
                    </Field>
                  </Box>
                </Group>

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
                    <Field name="summaryModel" label="Summary model">
                      <TextInput name="summaryModel" placeholder="gpt-5-mini" />
                    </Field>
                    <Field name="embeddingModel" label="Embedding model">
                      <TextInput name="embeddingModel" placeholder="text-embedding-3-large" />
                    </Field>
                    <Field name="sceneModel" label="Scene generation model">
                      <TextInput name="sceneModel" placeholder="gpt-5.2" />
                    </Field>
                    <Field name="appEnhanceModel" label="App edit model">
                      <TextInput name="appEnhanceModel" placeholder="gpt-5.2" />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
                      <span>
                        Embeddings: {embeddingsCount}/{embeddingsTotal}
                      </span>
                      {embeddingsPollingIntervalId === null ? (
                        <Button
                          size="small"
                          color="secondary"
                          onClick={loadAiEmbeddingsStatus}
                          aria-label="Reload embeddings status"
                          title="Reload embeddings status"
                        >
                          <ArrowPathIcon className="h-4 w-4" />
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        color="secondary"
                        onClick={generateMissingEmbeddings}
                        disabled={isGeneratingEmbeddings || isDeletingEmbeddings || embeddingsMissing === 0}
                      >
                        {isGeneratingEmbeddings ? <Spinner color="white" /> : 'Generate missing'}
                      </Button>
                      <Button
                        size="small"
                        color="secondary"
                        onClick={deleteEmbeddings}
                        disabled={isGeneratingEmbeddings || isDeletingEmbeddings || embeddingsCount === 0}
                      >
                        {isDeletingEmbeddings ? <Spinner color="white" /> : 'Delete all'}
                      </Button>
                      {isGeneratingEmbeddings ? 'Generating embeddings' : null}
                    </div>
                  </Box>
                </Group>
                <Group name="posthog">
                  <H6 className="pt-4">PostHog</H6>
                  <Box className="p-2 space-y-2">
                    <Field
                      name="backendApiKey"
                      label="Backend API key"
                      secret={!!savedSettings?.posthog?.backendApiKey}
                    >
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
                      <Switch fullWidth />
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
                          color={savedSettings?.nix?.buildServerPrivateKey ? 'secondary' : 'primary'}
                          size="small"
                        >
                          Generate new keypair
                        </Button>
                      </>
                    ) : null}
                  </Box>
                </Group>
                <Group name="buildHost">
                  <H6 className="pt-4">Cross-compilation build host</H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">
                      When deploying FrameOS, we compile it from source. We can compile on-device for maximal
                      compatibility, but this is slow and inefficient. Therefore we also support cross-compilation,
                      where we compile the FrameOS binary on this server, and only upload the resulting binary onto the
                      device.
                    </p>
                    <p className="text-sm leading-loose">
                      Cross-compilation is performed via Docker. We need to spin up new docker containers for the
                      various build environments. If FrameOS itself is running in Docker, we will need to run
                      Docker-in-Docker, which requires elevated privileges. See the{' '}
                      <a href="https://github.com/FrameOS/frameos/blob/main/README.md" target="_blank">
                        README
                      </a>{' '}
                      for more.
                    </p>
                    <p className="text-sm leading-loose">
                      Alternatively you may configure a remote build host below. The backend will upload generated C
                      sources and sysroot assets via SSH/SCP, run Docker Buildx on that host, and download the resulting
                      binary. Ensure Docker and the Docker Buildx plugin are installed on your build host. For best
                      performance, make sure this is an ARM-based system.
                    </p>
                    <Field name="enabled" label="Enable build host">
                      <Switch fullWidth />
                    </Field>
                    {settings?.buildHost?.enabled ? (
                      <>
                        <Field name="host" label="Build host address">
                          <TextInput placeholder="builder.example.com" />
                        </Field>
                        <Field name="port" label="SSH port">
                          <NumberTextInput placeholder="22" />
                        </Field>
                        <Field name="user" label="SSH user">
                          <TextInput placeholder="ubuntu" />
                        </Field>
                        <Field name="sshKey" label="Private SSH key" secret={!!savedSettings?.buildHost?.sshKey}>
                          <TextArea rows={3} />
                        </Field>
                        <Field
                          name="sshPublicKey"
                          label="Public SSH key"
                          secret={!!savedSettings?.buildHost?.sshPublicKey}
                        >
                          <TextArea rows={3} />
                        </Field>
                        <Button
                          onClick={newBuildHostKey}
                          color={savedSettings?.buildHost?.sshKey ? 'secondary' : 'primary'}
                          size="small"
                        >
                          Generate new keypair
                        </Button>
                      </>
                    ) : null}
                  </Box>
                </Group>
              </Form>
              <H6 className="pt-4">System information</H6>
              <SystemInfo />
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
