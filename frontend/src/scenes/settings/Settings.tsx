import { useActions, useValues } from 'kea'
import { Form, Group } from 'kea-forms'
import { Box } from '../../components/Box'
import { settingsLogic } from './settingsLogic'
import { Spinner } from '../../components/Spinner'
import { H6 } from '../../components/H6'
import { TextInput } from '../../components/TextInput'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { TextArea } from '../../components/TextArea'
import { sceneLogic } from '../sceneLogic'
import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { NumberTextInput } from '../../components/NumberTextInput'
import { Switch } from '../../components/Switch'
import { Select } from '../../components/Select'
import { SystemInfo } from './SystemInfo'
import { normalizeSshKeys, getDefaultSshKeyIds } from '../../utils/sshKeys'
import { framesModel } from '../../models/framesModel'
import { frameHost } from '../../decorators/frame'
import { A } from 'kea-router'
import { urls } from '../../urls'
import { Tag } from '../../components/Tag'
import { Label } from '../../components/Label'
import { FrameosShell } from '../workspace/FrameosShell'
import { isMobileWorkspaceViewport, workspaceLogic } from '../workspace/workspaceLogic'
import { accountLogic } from './accountLogic'
import versions from '../../../../versions.json'
import { timezoneOptions } from '../../decorators/timezones'

const settingsNavItems = [
  ['Account', '#settings-account'],
  ['Defaults', '#settings-defaults'],
  ['SSH Keys', '#settings-ssh'],
  ['FrameOS Gallery', '#settings-gallery'],
  ['OpenAI', '#settings-openai'],
  ['PostHog', '#settings-posthog'],
  ['Home Assistant', '#settings-home-assistant'],
  ['GitHub', '#settings-github'],
  ['Unsplash API', '#settings-unsplash'],
  ['Cross-compilation build host', '#settings-build-host'],
  ['System information', '#settings-system'],
  ['Custom fonts', '#settings-fonts'],
] as const

const frameosVersion = typeof versions.frameos === 'string' ? versions.frameos.split('+')[0] : null
const frameosVersionLabel = frameosVersion ? `FrameOS ${frameosVersion}` : 'FrameOS'

function settingsHeaderOffset(): number {
  if (typeof window === 'undefined') {
    return 0
  }

  return window.matchMedia?.('(max-width: 639px)').matches ? 96 : 104
}

function scrollToSettingsSection(sectionId: string, attempt = 0): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  window.requestAnimationFrame(() => {
    const section = document.getElementById(sectionId)
    if (section) {
      if (isMobileWorkspaceViewport()) {
        const top = section.getBoundingClientRect().top + window.scrollY - settingsHeaderOffset()
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      } else {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      return
    }

    if (attempt < 8) {
      window.setTimeout(() => scrollToSettingsSection(sectionId, attempt + 1), 50)
    }
  })
}

function AccountSettingsSection(): JSX.Element {
  const {
    account,
    accountEmail,
    accountLoading,
    accountPasswordChanged,
    emailEditorOpen,
    isAccountEmailSubmitting,
    isAccountPasswordSubmitting,
    passwordChanged,
    passwordEditorOpen,
  } = useValues(accountLogic)
  const { beginEmailChange, resetAccountEmail, resetAccountPassword, setEmailEditorOpen, setPasswordEditorOpen } =
    useActions(accountLogic)
  const currentEmail = account?.email ?? ''
  const editedEmail = accountEmail.email.trim()
  const emailSubmitDisabled = !editedEmail || editedEmail === currentEmail || isAccountEmailSubmitting

  return (
    <div className="space-y-4">
      <H6 id="settings-account" className="pt-4">
        Account
      </H6>
      <Box className="settings-account-card space-y-4">
        <div className="space-y-1 @md:flex @md:gap-2">
          <div className="@md:w-1/3">
            <Label>Email</Label>
          </div>
          {emailEditorOpen ? (
            <Form
              logic={accountLogic}
              formKey="accountEmail"
              enableFormOnSubmit
              className="flex w-full min-w-0 flex-wrap items-start gap-2"
            >
              <Field name="email" className="min-w-[14rem] flex-1">
                <TextInput type="email" autoComplete="email" autoFocus />
              </Field>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  color="secondary"
                  size="small"
                  onClick={() => {
                    resetAccountEmail()
                    setEmailEditorOpen(false)
                  }}
                  disabled={isAccountEmailSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  color={!emailSubmitDisabled ? 'primary' : 'secondary'}
                  size="small"
                  disabled={emailSubmitDisabled}
                  className="inline-flex items-center gap-2"
                >
                  {isAccountEmailSubmitting ? <Spinner color="white" /> : null}
                  Change email
                </Button>
              </div>
            </Form>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-2 text-sm">
              {accountLoading ? <Spinner /> : <span className="frameos-strong font-medium">{currentEmail}</span>}
              <button
                type="button"
                onClick={() => beginEmailChange()}
                disabled={accountLoading}
                title="Change email"
                aria-label="Change email"
                className="frameos-muted inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent !px-0 !py-0 transition hover:bg-slate-500/10 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
              >
                <PencilSquareIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        {passwordEditorOpen ? (
          <Form logic={accountLogic} formKey="accountPassword" enableFormOnSubmit className="space-y-3">
            <Field name="current_password" label="Current password">
              <TextInput type="password" autoComplete="current-password" />
            </Field>
            <Field name="password" label="New password">
              <TextInput type="password" autoComplete="new-password" />
            </Field>
            <Field name="password2" label="Confirm password">
              <TextInput type="password" autoComplete="new-password" />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                color="secondary"
                size="small"
                onClick={() => {
                  resetAccountPassword()
                  setPasswordEditorOpen(false)
                }}
                disabled={isAccountPasswordSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                color={accountPasswordChanged ? 'primary' : 'secondary'}
                size="small"
                disabled={!accountPasswordChanged || isAccountPasswordSubmitting}
                className="inline-flex items-center gap-2"
              >
                {isAccountPasswordSubmitting ? <Spinner color="white" /> : null}
                Change password
              </Button>
            </div>
          </Form>
        ) : (
          <div className="space-y-1 @md:flex @md:gap-2">
            <div className="@md:w-1/3">
              <Label>Password</Label>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPasswordEditorOpen(true)}
                className="frameos-link font-semibold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Change password
              </button>
              {passwordChanged ? <span className="text-emerald-500">Password updated.</span> : null}
            </div>
          </div>
        )}
      </Box>
    </div>
  )
}

function IngressAccountSettingsSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <H6 id="settings-account" className="pt-4">
        Account
      </H6>
      <Box className="settings-account-card">
        <div className="frameos-muted text-sm">Account access is managed by Home Assistant ingress.</div>
      </Box>
    </div>
  )
}

export function Settings() {
  const {
    settings,
    savedSettings,
    savedSettingsLoading,
    settingsChanged,
    isSettingsSubmitting,
    openAiModelOverridesExpanded,
    customFontsLoading,
    isCustomFontsFormSubmitting,
    customFonts,
    generatingSshKeyId,
    sshKeyExpandedIds,
  } = useValues(settingsLogic)
  const { framesList } = useValues(framesModel)
  const {
    submitSettings,
    resetSettings,
    addSshKey,
    generateSshKey,
    removeSshKey,
    newBuildHostKey,
    deleteCustomFont,
    setSettingsValue,
    toggleSshKeyExpanded,
    toggleOpenAiModelOverrides,
  } = useActions(settingsLogic)
  const { isHassioIngress } = useValues(sceneLogic)
  const { logout } = useActions(sceneLogic)
  const { closeSecondarySidebar } = useActions(workspaceLogic)
  const defaultSshKeyIds = getDefaultSshKeyIds(settings?.ssh_keys)
  const framesUsingKey = (keyId: string) =>
    framesList.filter((frame) => (frame.ssh_keys ?? defaultSshKeyIds).includes(keyId))
  const settingsTree = (
    <div className="space-y-1">
      {settingsNavItems.map(([label, href]) => (
        <a
          key={href}
          href={href}
          onClick={(event) => {
            if (!isMobileWorkspaceViewport()) {
              return
            }

            event.preventDefault()
            closeSecondarySidebar()
            window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${href}`)
            scrollToSettingsSection(href.slice(1))
          }}
          className="frameos-settings-nav-link block rounded-xl px-3 py-2.5 text-base font-medium text-slate-700 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {label}
        </a>
      ))}
    </div>
  )
  const settingsActions = (
    <div className="settings-page-actions flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="frameos-muted shrink-0 text-xs tracking-wide text-slate-400">{frameosVersionLabel}</div>
      <div className="flex flex-wrap items-center gap-2">
        {!isHassioIngress ? (
          <Button size="small" color="secondary" onClick={logout} className="rounded-lg px-4 py-2">
            Logout
          </Button>
        ) : null}
        <Button
          size="small"
          color="secondary"
          onClick={() => resetSettings(savedSettings)}
          disabled={!settingsChanged || isSettingsSubmitting}
          className="rounded-lg px-4 py-2"
        >
          Reset
        </Button>
        <Button
          size="small"
          color={settingsChanged ? 'primary' : 'secondary'}
          onClick={submitSettings}
          disabled={!settingsChanged || isSettingsSubmitting}
          className="rounded-lg px-4 py-2"
        >
          Save
        </Button>
      </div>
    </div>
  )

  return (
    <FrameosShell
      mode="settings"
      title="Settings"
      subtitle="System configuration"
      tree={settingsTree}
      mainClassName="settings-workspace-main min-h-screen overflow-visible py-6 pr-8 max-lg:min-h-0 max-lg:px-4 max-lg:pb-6 max-lg:pt-0"
      topBar={null}
    >
      <div>
        <div className="settings-page-header mx-auto mb-6 max-w-5xl">
          <h1 className="frameos-strong text-3xl font-bold tracking-normal text-slate-950">Global settings</h1>
          {settingsActions}
        </div>
        <div className="frame-tool-panel frame-settings-panel settings-panel mx-auto max-w-5xl @container">
          {isHassioIngress ? <IngressAccountSettingsSection /> : <AccountSettingsSection />}
          {savedSettingsLoading ? (
            <Spinner />
          ) : (
            <>
              <Form logic={settingsLogic} formKey="settings" props={{}} onSubmit={submitSettings} className="space-y-4">
                <Group name="defaults">
                  <H6 id="settings-defaults" className="pt-4">
                    Defaults
                  </H6>
                  <Box className="p-3 space-y-3">
                    <Field
                      name="timezone"
                      label="Default Buildroot timezone"
                      tooltip="Used for Buildroot SD card images unless a frame overrides it."
                    >
                      <Select options={timezoneOptions} />
                    </Field>
                    <Field
                      name="wifiSSID"
                      label="Default WiFi network"
                      tooltip="Prefilled when adding Buildroot SD card frames."
                    >
                      <TextInput autoComplete="off" />
                    </Field>
                    <Field
                      name="wifiPassword"
                      label="Default WiFi password"
                      secret={!!savedSettings?.defaults?.wifiPassword}
                      tooltip="Prefilled when adding Buildroot SD card frames."
                    >
                      <TextInput type="password" autoComplete="new-password" />
                    </Field>
                  </Box>
                </Group>
                <Group name="ssh_keys">
                  <H6 id="settings-ssh" className="pt-4">
                    SSH Keys
                  </H6>
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
                              <div className="frameos-strong text-sm font-semibold">
                                {key.name || `Key ${index + 1}`}
                                {isUsedForNewFrames ? (
                                  <Tag color="primary" className="ml-2">
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
                                <div className="frameos-muted text-xs space-y-1">
                                  <span className="frameos-strong font-semibold">Frames using this key:</span>
                                  {matchingFrames.length === 0 ? (
                                    <div>None.</div>
                                  ) : (
                                    <div className="flex flex-wrap gap-2">
                                      {matchingFrames.map((frame) => (
                                        <A
                                          key={frame.id}
                                          href={urls.frame(frame.id)}
                                          className="frameos-link hover:underline"
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
                <Group name="openAI">
                  <H6 id="settings-openai" className="pt-4">
                    OpenAI
                  </H6>
                  <Box className="p-2 space-y-2">
                    <p className="text-sm leading-loose">
                      The OpenAI API key is used within OpenAI apps on frames. The backend key powers AI features in the
                      control plane.
                    </p>
                    <Field name="apiKey" label="API key for frames" secret={!!savedSettings?.openAI?.apiKey}>
                      <TextInput name="apiKey" />
                    </Field>
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
                    {openAiModelOverridesExpanded ? (
                      <div className="space-y-2 border-t border-slate-500/20 pt-3">
                        <Field name="chatModel" label="Chat model">
                          <TextInput name="chatModel" placeholder="Use shared model" />
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
                        <Field name="appEnhanceModel" label="App source enhance model">
                          <TextInput name="appEnhanceModel" placeholder="Use shared model" />
                        </Field>
                      </div>
                    ) : null}
                  </Box>
                </Group>
                <Group name="posthog">
                  <H6 id="settings-posthog" className="pt-4">
                    PostHog
                  </H6>
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
                  <H6 id="settings-home-assistant" className="pt-4">
                    Home Assistant
                  </H6>
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
                  <H6 id="settings-github" className="pt-4">
                    GitHub
                  </H6>
                  <Box className="p-2 space-y-2">
                    <Field name="api_key" label="API key" secret={!!savedSettings?.github?.api_key}>
                      <TextInput />
                    </Field>
                  </Box>
                </Group>
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
                <Group name="buildHost">
                  <H6 id="settings-build-host" className="pt-4">
                    Cross-compilation build host
                  </H6>
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
                      Alternatively you may configure a remote build host below. We'll upload generated C sources and
                      sysroot assets via SSH/SCP, run Docker Buildx on that host, and download the resulting binary.
                      Ensure Docker and the Docker Buildx plugin are installed on your build host. For best performance,
                      make sure this is an ARM-based system when deploying to an ARM-based system like the Raspberry Pi.
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
              <H6 id="settings-system" className="pt-4">
                System information
              </H6>
              <SystemInfo />
              <div className="space-y-4 mt-4">
                <H6 id="settings-fonts" className="pt-4">
                  Custom fonts
                </H6>
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
    </FrameosShell>
  )
}

export default Settings
