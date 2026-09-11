import { Group } from 'kea-forms'
import { A } from 'kea-router'
import { ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { Box } from '../../../../../components/Box'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { Label } from '../../../../../components/Label'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { SshKeysSection } from '../../../../../components/sshKeys/SshKeysSection'
import { Switch } from '../../../../../components/Switch'
import { TextArea } from '../../../../../components/TextArea'
import { TextInput } from '../../../../../components/TextInput'
import { secureToken } from '../../../../../utils/secureToken'
import { useFrameSettings } from '../frameSettingsContext'
import { getCertificateHint } from '../frameSettingsHelpers'
import { FrameSettingsSection, SectionBody, SectionHeading } from './FrameSettingsSection'

/**
 * How this frame is reached, and who may reach it: SSH, the FrameOS Remote
 * agent, the backend it reports to, its own HTTP API, its admin panel and its
 * TLS material.
 *
 * A cloud-managed frame has none of these knobs — it dials the hub itself over
 * one outbound WebSocket — with one exception: the account's SSH public keys
 * are written into the SD cards the cloud builds for a Linux frame, and that
 * list is edited here.
 */

/**
 * The account's SSH keys, on a cloud-managed Linux frame. The cloud never logs
 * in to a frame itself; these go on the card.
 */
export function CloudSshKeysSection(): JSX.Element {
  return (
    <>
      <SectionHeading id="frame-settings-ssh" className="mt-2">
        SSH keys
      </SectionHeading>
      <Box className="p-2 space-y-2">
        <p className="text-sm leading-relaxed">
          The cloud never logs in to a frame itself. These keys go on the SD card when you write one for this frame
          (&ldquo;Write another SD card&rdquo; in the deploy panel), as root&apos;s authorized keys.
        </p>
        <SshKeysSection />
      </Box>
    </>
  )
}

/** SSH (backend → frame), and the frame host an embedded board is given. */
export function SshSection(): JSX.Element {
  const {
    frame,
    frameForm,
    frameFormTouches,
    mode,
    isEmbeddedMode,
    touchFrameFormField,
    setFrameFormValues,
    forgetSshHostKey,
    updateDeployedSshKeys,
    hasSshKeyChangesToDeploy,
    openLogs,
  } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-ssh" className="mt-2">
        {isEmbeddedMode ? (
          <>Frame host</>
        ) : (
          <>
            SSH <span className="text-gray-500">(backend &#8594; frame)</span>
          </>
        )}
      </SectionHeading>
      <SectionBody>
        <Field
          name="frame_host"
          label="Frame host"
          tooltip={
            <div className="space-y-2">
              {isEmbeddedMode ? (
                <>
                  <p>
                    The hostname to bake into the ESP32 firmware. A value like frame.local sets the device hostname to
                    frame.
                  </p>
                  <p>Leave it blank to use the generated frame hostname.</p>
                </>
              ) : (
                <>
                  <p>The hostname or IP address that the backend uses to connect to the frame for SSH and HTTP.</p>
                  <p>You can leave it blank if you only use FrameOS Remote to communicate.</p>
                </>
              )}
            </div>
          }
        >
          <TextInput name="frame_host" placeholder={`frame${frame.id}.local`} required />
        </Field>
        {!isEmbeddedMode ? (
          <>
            <Field name="ssh_user" label="SSH user">
              <TextInput name="ssh_user" placeholder="pi" required />
            </Field>
            <Field
              name="ssh_pass"
              label="SSH pass"
              tooltip={
                <p>
                  Leave empty to use a SSH key. Configure it under{' '}
                  <A href="/settings" className="frameos-link hover:underline">
                    global settings.
                  </A>
                </p>
              }
            >
              <TextInput
                name="ssh_pass"
                onClick={() => touchFrameFormField('ssh_pass')}
                type={frameFormTouches.ssh_pass ? 'text' : 'password'}
                placeholder="no password, using SSH key"
              />
            </Field>
            <Field name="ssh_port" label="SSH port">
              <TextInput name="ssh_port" placeholder="22" required />
            </Field>
            <div className="@md:flex @md:gap-2">
              <Label className="@md:w-1/3">SSH host key</Label>
              <div className="w-full space-y-2">
                {frame.ssh_host_key ? (
                  <>
                    <div className="text-sm break-all">
                      {frame.ssh_host_key.split(' ')[0]} {frame.ssh_host_key_fingerprint}
                    </div>
                    <div className="flex gap-2">
                      <Button size="small" color="secondary" onClick={() => forgetSshHostKey()}>
                        Forget host key
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">
                      Pinned on the first connection; any other key is refused. Forget it only after reinstalling the
                      frame, then the next connection records the new key.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-gray-500">
                    Not recorded yet. The key the frame offers on the next SSH connection is pinned, and any other key
                    is refused from then on.
                  </p>
                )}
              </div>
            </div>
            <div className="@md:flex @md:gap-2">
              <Label className="@md:w-1/3">SSH Keys</Label>
              <div className="w-full space-y-2">
                <SshKeysSection
                  selectedIds={frameForm.ssh_keys ?? frame.ssh_keys ?? []}
                  onSelectionChange={(ids) => setFrameFormValues({ ssh_keys: ids })}
                />
                {mode === 'rpios' ? (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      color={hasSshKeyChangesToDeploy ? 'primary' : 'secondary'}
                      onClick={() => {
                        updateDeployedSshKeys()
                        openLogs()
                      }}
                      disabled={(frameForm.ssh_keys ?? frame.ssh_keys ?? []).length === 0}
                    >
                      Save changes & update deployed keys
                    </Button>
                  </div>
                ) : null}
                <p className="text-xs text-gray-500">
                  At least one previously installed key must remain when updating deployed keys.
                </p>
              </div>
            </div>
          </>
        ) : null}
      </SectionBody>
    </>
  )
}

/** FrameOS Remote: the frame dials the backend, the backend drives the frame. */
export function RemoteAgentSection(): JSX.Element | null {
  const { frameForm, frameFormTouches, isEmbeddedMode, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  if (isEmbeddedMode) {
    return null
  }
  return (
    <>
      <SectionHeading id="frame-settings-agent">
        Remote control - beta <span className="text-gray-500">(frame &#8594; backend &#8594; frame)</span>
      </SectionHeading>
      <SectionBody>
        <Group name="agent">
          <Field
            name="agentEnabled"
            label="Remote enabled"
            tooltip={
              <div className="space-y-2">
                <p>
                  FrameOS Remote opens a websocket connection from the frame to the backend, which is then used by the
                  backend to control the frame. This allows you to control the frame even if it&apos;s behind a
                  firewall. The backend must be publicly accessible for this to work.
                </p>
                <p>
                  This is still beta. Enable both toggles, then save and deploy the frame. FrameOS Remote will then
                  connect to the backend to await further commands.
                </p>
                <p>
                  Buildroot SD images ship without FrameOS Remote: the deploy that turns this on installs it. A frame
                  with it enabled also runs FrameOS as root rather than the unprivileged &lsquo;frameos&rsquo; user,
                  because the backend deploys into it as root.
                </p>
                <p>
                  Note: after enabling FrameOS Remote, you must manually deploy it from the &quot;...&quot; -&gt;
                  &quot;Deploy Remote&quot; menu in the top.
                </p>
              </div>
            }
          >
            <Switch name="agentEnabled" fullWidth />
          </Field>
          {frameForm.agent?.agentEnabled && (
            <>
              <Field
                name="agentRunCommands"
                label="Allow remote control"
                tooltip={
                  <div className="space-y-2">
                    <p>Can FrameOS Remote actually run commands and execute updates?</p>
                    <p>
                      This is how deploys reach a frame the backend cannot SSH into. It is a shell on the device: the
                      frame runs whatever the backend sends it, as root.
                    </p>
                    <p>
                      This is a second &quot;are you really sure?&quot; toggle, as this comes with risk when enabled on
                      an unsecure connection.
                    </p>
                    <p>
                      Make sure you&apos;re either aware of the risks, or that the backend is only accessible over HTTPS
                      before enabling this.
                    </p>
                  </div>
                }
              >
                {({ value, onChange }) => (
                  <div className="w-full">
                    <Switch name="agentRunCommands" value={value} onChange={onChange} />
                  </div>
                )}
              </Field>
              <Field
                name="agentSharedSecret"
                label={<div>Remote shared secret</div>}
                labelRight={
                  <Button
                    color="secondary"
                    size="small"
                    onClick={() => {
                      setFrameFormValues({
                        agent: { ...(frameForm.agent ?? {}), agentSharedSecret: secureToken(20) },
                      })
                      touchFrameFormField('agent.agentSharedSecret')
                    }}
                  >
                    Regenerate
                  </Button>
                }
                tooltip="This key is used as part of the handshake when communicating with the frame over websockets."
              >
                <TextInput
                  name="agentSharedSecret"
                  onClick={() => touchFrameFormField('agent.agentSharedSecret')}
                  type={frameFormTouches['agent.agentSharedSecret'] ? 'text' : 'password'}
                  placeholder=""
                  required
                />
              </Field>
            </>
          )}
        </Group>
      </SectionBody>
    </>
  )
}

/**
 * "frame → backend" reporting: a cloud frame talks only to the hub, so the
 * section is absent there (and so is its nav anchor — see
 * allowedFrameSettingsSections in workspaceSurfaces.ts).
 */
export function BackendAccessSection(): JSX.Element {
  const { frameFormTouches, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-backend" className="mt-2">
        Backend access <span className="text-gray-500">(frame &#8594; backend)</span>
      </SectionHeading>
      <SectionBody>
        <Field
          name="server_host"
          label="Backend host"
          tooltip={
            <>
              The public host of your FrameOS backend server (this webserver). This is what the frame uses to reach the
              backend.
            </>
          }
        >
          <TextInput name="server_host" placeholder="localhost" required />
        </Field>
        <Field name="server_port" label="Backend port" tooltip="The port the backend server is running on.">
          <TextInput name="server_port" placeholder="8989" required />
        </Field>
        <Field
          name="server_scheme"
          label="Backend scheme"
          tooltip={
            <>
              Whether the frame reaches the backend over plain HTTP or HTTPS. This decides the log shipper, FrameOS
              Remote (ws:// vs wss://) and ESP32 provisioning alike; it is never guessed from the port.
            </>
          }
        >
          {({ value, onChange }) => (
            <Select
              name="server_scheme"
              value={value === 'https' ? 'https' : 'http'}
              onChange={(v) => onChange(v === 'https' ? 'https' : 'http')}
              options={[
                { value: 'http', label: 'http (plain)' },
                { value: 'https', label: 'https (TLS)' },
              ]}
            />
          )}
        </Field>
        <Field
          name="server_api_key"
          label={<div>Backend API key</div>}
          labelRight={
            <Button
              color="secondary"
              size="small"
              onClick={() => {
                setFrameFormValues({ server_api_key: secureToken(32) })
                touchFrameFormField('server_api_key')
              }}
            >
              Regenerate
            </Button>
          }
          tooltip="This key is used by the frame to access the backend server's API. For example to send logs. It should be kept secret."
        >
          <TextInput
            name="server_api_key"
            onClick={() => touchFrameFormField('server_api_key')}
            type={frameFormTouches.server_api_key ? 'text' : 'password'}
            placeholder=""
            required
          />
        </Field>
        <Field
          name="server_send_logs"
          label="Send logs to backend"
          tooltip="When disabled, the frame will not upload logs to the backend API."
        >
          {({ value, onChange }) => (
            <Switch name="server_send_logs" value={value ?? true} onChange={onChange} fullWidth />
          )}
        </Field>
      </SectionBody>
    </>
  )
}

/** The HTTP API the frame serves, and who may call it. */
export function HttpApiSection(): JSX.Element {
  const { frameFormTouches, isEmbeddedMode, setFrameFormValues, touchFrameFormField } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-http-api-section">
        HTTP API on frame <span className="text-gray-500">(backend &#8594; frame)</span>
      </SectionHeading>
      <SectionBody>
        <Field
          name="frame_port"
          label="HTTP port on frame"
          tooltip={
            <div className="space-y-2">
              <p>The port on which the frame accepts HTTP API requests and serves a simple control interface.</p>
              <p>
                {isEmbeddedMode
                  ? 'Embedded firmware keeps HTTP available for provisioning and recovery. Enable HTTPS below for backend-to-frame traffic.'
                  : 'Traffic on this port is UNSECURED! Please also enable the HTTPS proxy service for secure communication.'}
              </p>
            </div>
          }
        >
          <TextInput name="frame_port" placeholder={isEmbeddedMode ? '80' : '8787'} required />
        </Field>
        {!isEmbeddedMode ? (
          <>
            <Field
              name="frame_access"
              label="HTTP access level"
              tooltip={
                <div className="space-y-2">
                  <p>
                    <strong>Private (default):</strong> You need a key to both view and administer the frame.
                  </p>
                  <p>
                    <strong>Protected:</strong> Everyone can view the frame&apos;s image, but you need the access key to
                    administer content.
                  </p>
                  <p>
                    <strong>Public:</strong> Everyone can view or administer the frame without a key.
                  </p>
                </div>
              }
            >
              <Select
                name="frame_access"
                options={[
                  { value: 'private', label: 'Private (key needed to view and administer)' },
                  { value: 'protected', label: 'Protected (no key needed to view, key needed to administer)' },
                  { value: 'public', label: 'Public (no key needed to view or administer)' },
                ]}
              />
            </Field>
            <Field
              name="frame_access_key"
              label={<div>HTTP access key</div>}
              labelRight={
                <Button
                  color="secondary"
                  size="small"
                  onClick={() => {
                    setFrameFormValues({ frame_access_key: secureToken(20) })
                    touchFrameFormField('frame_access_key')
                  }}
                >
                  Regenerate
                </Button>
              }
              tooltip="This key is used when communicating with the frame over HTTP."
            >
              <TextInput
                name="frame_access_key"
                onClick={() => touchFrameFormField('frame_access_key')}
                type={frameFormTouches.frame_access_key ? 'text' : 'password'}
                placeholder=""
                required
              />
            </Field>
          </>
        ) : null}
      </SectionBody>
    </>
  )
}

/** The admin panel the frame hosts, and the credentials that guard it. */
export function FrameAdminPanelSection(): JSX.Element {
  const {
    frameForm,
    frameFormTouches,
    adminUrl,
    adminLoginIsOnlyAccess,
    embeddedAdminAuthMissing,
    isEmbeddedMode,
    generateFrameAdminCredentials,
    touchFrameFormField,
  } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-settings-admin">
        {isEmbeddedMode ? 'Frame setup access' : 'Frame admin panel (BETA)'}
      </SectionHeading>
      <p className="pl-2 @md:pl-8 text-sm text-gray-500">
        {isEmbeddedMode ? (
          <>
            Protects the ESP32 setup and control URL on normal Wi-Fi. Hotspot provisioning stays open so a new device
            can be configured.
          </>
        ) : (
          <>
            Hosted on the frame at <code>/admin</code>, similar to the interface you&apos;re using now. This is still in
            beta: you can&apos;t save any changes.{' '}
          </>
        )}
      </p>
      <SectionBody>
        {embeddedAdminAuthMissing ? (
          <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-none" />
            <div>
              Set an admin username and password before deploying ESP32 firmware. Without it, the on-frame setup URL is
              locked outside hotspot mode.
            </div>
          </div>
        ) : null}
        <Field
          name="frame_admin_auth.enabled"
          label={isEmbeddedMode ? 'Require username/password' : 'Admin panel enabled'}
          labelRight={
            !isEmbeddedMode && adminUrl ? (
              <A
                href={adminUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="frameos-link text-sm hover:underline"
              >
                Open
              </A>
            ) : (
              <></>
            )
          }
        >
          <Switch disabled={adminLoginIsOnlyAccess} />
        </Field>
        {adminLoginIsOnlyAccess ? (
          <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-none" />
            <div>
              This login is the only way this backend reaches the frame: the card has no FrameOS Remote and no SSH key
              or password. It stays on, and the password cannot be left blank. Change it here and it is written to the
              frame on Save.
            </div>
          </div>
        ) : null}
        {frameForm.frame_admin_auth?.enabled ? (
          <>
            <Field name="frame_admin_auth.user" label="Username">
              <TextInput />
            </Field>
            <Field
              name="frame_admin_auth.pass"
              label="Password"
              labelRight={
                <Button color="secondary" size="small" onClick={() => generateFrameAdminCredentials()}>
                  Generate
                </Button>
              }
            >
              <TextInput
                onClick={() => touchFrameFormField('frame_admin_auth.pass')}
                type={frameFormTouches['frame_admin_auth.pass'] ? 'text' : 'password'}
                placeholder=""
                required
              />
            </Field>
          </>
        ) : null}
      </SectionBody>
    </>
  )
}

/** TLS: Caddy in front of the API on a Pi, native HTTPS on an ESP32. */
export function HttpsProxySection(): JSX.Element {
  const {
    frame,
    frameForm,
    frameFormTouches,
    isEmbeddedMode,
    tlsEnabled,
    generateTlsCertificates,
    verifyTlsCertificates,
  } = useFrameSettings()
  return (
    <>
      <SectionHeading id="frame-http-proxy-section">
        {isEmbeddedMode ? 'HTTPS on frame' : 'HTTPS proxy'}{' '}
        <span className="text-gray-500">(backend &#8594; frame)</span>
      </SectionHeading>
      <SectionBody>
        <Field
          name="https_proxy.enable"
          label={isEmbeddedMode ? 'Native HTTPS API' : 'HTTPS proxy via Caddy'}
          tooltip={
            isEmbeddedMode
              ? 'Serve the frame API over HTTPS with the same per-frame certificate material used by other FrameOS frames. The certificate and key reach the board on its next settings poll; it restarts to apply them.'
              : 'Enable Caddy as a local HTTPS proxy for the FrameOS HTTP API. You may need to do a full deploy if this is your first time enabling this.'
          }
        >
          {({ value, onChange }) => (
            <Switch
              name="https_proxy.enable"
              value={value}
              onChange={(enableTls) => {
                if (enableTls) {
                  verifyTlsCertificates()
                }
                onChange(enableTls)
              }}
              fullWidth
            />
          )}
        </Field>
        {tlsEnabled ? (
          <>
            <Field
              name="https_proxy.port"
              label="HTTPS port"
              tooltip={
                <div className="space-y-2">
                  <p>
                    {isEmbeddedMode
                      ? "The port the frame's HTTPS server listens on."
                      : 'The port Caddy listens on for HTTPS connections.'}
                  </p>
                  <p>It&apos;s best if this ends with *443.</p>
                </div>
              }
            >
              <NumberTextInput name="https_proxy.port" placeholder="8443" />
            </Field>
            {!isEmbeddedMode ? (
              <Field
                name="https_proxy.expose_only_port"
                label="Expose only HTTPS port"
                tooltip="Bind the HTTP port to 127.0.0.1 so only the HTTPS proxy is accessible externally."
              >
                <Switch name="https_proxy.expose_only_port" fullWidth />
              </Field>
            ) : null}
            <Field
              name="https_proxy.certs.client_ca"
              label="HTTPS backend CA certificate"
              labelRight={
                <Button color="secondary" size="small" onClick={() => generateTlsCertificates()}>
                  Regenerate
                </Button>
              }
              tooltip="Used by the backend to validate HTTPS connections to this frame when TLS is enabled."
              secret={!frameFormTouches['https_proxy.certs.client_ca'] && !!frameForm.https_proxy?.certs?.client_ca}
              hint={getCertificateHint(
                'Root CA certificate',
                frameForm.https_proxy?.client_ca_cert_not_valid_after ??
                  frame.https_proxy?.client_ca_cert_not_valid_after
              )}
            >
              <TextArea name="https_proxy.certs.client_ca" rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
            </Field>
            <Field
              name="https_proxy.certs.server"
              label="HTTPS frame certificate"
              tooltip={
                isEmbeddedMode
                  ? 'PEM certificate baked into the firmware for native HTTPS on this frame.'
                  : 'PEM certificate used by Caddy for HTTPS on this frame.'
              }
              secret={!frameFormTouches['https_proxy.certs.server'] && !!frameForm.https_proxy?.certs?.server}
              hint={getCertificateHint(
                'Server certificate',
                frameForm.https_proxy?.server_cert_not_valid_after ?? frame.https_proxy?.server_cert_not_valid_after
              )}
            >
              <TextArea name="https_proxy.certs.server" rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
            </Field>

            <Field
              name="https_proxy.certs.server_key"
              label={<div>HTTPS frame private key</div>}
              tooltip={
                isEmbeddedMode
                  ? 'PEM private key baked into the firmware for native HTTPS on this frame. Keep this secret.'
                  : 'PEM private key used by Caddy for HTTPS on this frame. Keep this secret.'
              }
              secret={!frameFormTouches['https_proxy.certs.server_key'] && !!frameForm.https_proxy?.certs?.server_key}
            >
              <TextArea name="https_proxy.certs.server_key" rows={4} placeholder="-----BEGIN EC PRIVATE KEY-----" />
            </Field>
          </>
        ) : null}
      </SectionBody>
    </>
  )
}
