import clsx from 'clsx'
import { Form } from 'kea-forms'
import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { Spinner } from '../../../../components/Spinner'
import { CloudSettingsSection } from '../../../settings/CloudSettings'
import { FrameSettingsProvider, useFrameSettings, type FrameSettingsProps } from './frameSettingsContext'
import { GpioButtonsSection } from './fields/sharedFields'
import { FrameSettingsSection } from './sections/FrameSettingsSection'
import { SettingsHeaderActions } from './SettingsHeaderActions'
import {
  CloudServiceSettingsSection,
  CloudTelemetrySection,
  FrameAdminServiceSecretsSection,
  FrameAdminUpgradeSection,
  StoreSceneServiceSettingsSection,
} from './sections/accountSections'
import {
  CloudBaseSettingsSection,
  CloudEsp32Sections,
  CloudExtendedSettingsSections,
  CloudHardwareSection,
} from './sections/cloudSections'
import {
  BackendAccessSection,
  CloudSshKeysSection,
  FrameAdminPanelSection,
  HttpApiSection,
  HttpsProxySection,
  RemoteAgentSection,
  SshSection,
} from './sections/connectivitySections'
import {
  DeviceSettingsSection,
  EmbeddedPowerSection,
  FrameInfoSection,
  VirtualFrameSection,
} from './sections/deviceSections'
import {
  AssetsSection,
  DefaultsSection,
  ErrorBehaviorSection,
  LogsSection,
  MountpointsSection,
  NetworkSection,
  PaletteSection,
  QrControlCodeSection,
  RebootSection,
} from './sections/systemSections'

export type { FrameSettingsProps }

/**
 * The per-frame Settings panel: one form, rendered on four surfaces (the
 * self-hosted backend, the frame's own admin panel, and the two cloud
 * profiles).
 *
 * The list below is the whole panel. Which of these sections a surface
 * actually draws is declared in frameSettingsSurface.ts and enforced by
 * <FrameSettingsSection>; each section then decides for itself what the
 * frame's own hardware and firmware allow. Nothing here tests the mode.
 *
 * This used to be a single 4,300-line component with forty nested ternaries
 * over `cloudProfile` / `esp32CloudProfile` / `inFrameAdminMode`, and the
 * gating could not be reviewed by hand — which is exactly how the cloud's SSH
 * keys section came to be nested inside a `!cloudProfile` branch and stopped
 * rendering for a release.
 */
export function FrameSettings(props: FrameSettingsProps): JSX.Element {
  const { frameId } = useValues(frameLogic)
  return (
    <FrameSettingsProvider
      {...props}
      fallback={
        <div className={props.className}>
          Loading frame {frameId}...
          <Spinner />
        </div>
      }
    >
      <FrameSettingsPanel />
    </FrameSettingsProvider>
  )
}

function FrameSettingsPanel(): JSX.Element {
  const { className, scrollContainer = true, frameId } = useFrameSettings()
  return (
    <div
      className={clsx(
        'frame-tool-panel frame-settings-panel',
        scrollContainer ? 'h-full overflow-y-auto pr-2' : 'overflow-visible',
        className
      )}
      id="panel-settings-div"
    >
      {/* Contains its own <form>, so it must stay outside the frameForm <Form> below. */}
      <FrameSettingsSection sectionKey="cloud-account">
        <CloudSettingsSection headingId="frame-settings-cloud" action={<SettingsHeaderActions slot="cloud" />} />
      </FrameSettingsSection>
      <Form
        formKey="frameForm"
        logic={frameLogic}
        props={{ frameId }}
        className="space-y-4 @container"
        enableFormOnSubmit
      >
        {/* Cloud-managed frames: the pushable set, then the three firmware
            batches. */}
        <FrameSettingsSection sectionKey="cloud-base">
          <CloudBaseSettingsSection />
        </FrameSettingsSection>
        <CloudExtendedSettingsSections />
        <CloudHardwareSection />
        <CloudEsp32Sections />

        {/* Service keys, above the fold on every surface: "why is my scene
            asking for an API key" is answered here, not on the account-wide
            secrets page. */}
        <FrameSettingsSection sectionKey="cloud-service-settings">
          <CloudServiceSettingsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="store-scene-service-settings">
          <StoreSceneServiceSettingsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="cloud-telemetry">
          <CloudTelemetrySection />
        </FrameSettingsSection>

        {/* The full self-hosted surface. */}
        <FrameSettingsSection sectionKey="frame-info">
          <FrameInfoSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="frameos-upgrade">
          <FrameAdminUpgradeSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="service-secrets">
          <FrameAdminServiceSecretsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="device-settings">
          <DeviceSettingsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="virtual-frame">
          <VirtualFrameSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="embedded-power">
          <EmbeddedPowerSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="cloud-ssh-keys">
          <CloudSshKeysSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="ssh">
          <SshSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="remote-agent">
          <RemoteAgentSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="backend-access">
          <BackendAccessSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="http-api">
          <HttpApiSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="frame-admin-panel">
          <FrameAdminPanelSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="https-proxy">
          <HttpsProxySection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="network">
          <NetworkSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="mountpoints">
          <MountpointsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="defaults">
          <DefaultsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="error-behavior">
          <ErrorBehaviorSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="palette">
          <PaletteSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="qr">
          <QrControlCodeSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="assets">
          <AssetsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="logs">
          <LogsSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="reboot">
          <RebootSection />
        </FrameSettingsSection>
        <FrameSettingsSection sectionKey="gpio">
          <GpioButtonsSection />
        </FrameSettingsSection>
      </Form>
    </div>
  )
}
