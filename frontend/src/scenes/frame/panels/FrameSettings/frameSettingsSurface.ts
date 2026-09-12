import type { FrameType } from '../../../../types'
import {
  allowedFrameSettingsSections,
  isEsp32CloudFrame,
  workspaceMode,
  type WorkspaceMode,
} from '../../../workspace/workspaceSurfaces'

/**
 * The four surfaces the per-frame Settings panel is rendered on.
 *
 * `workspaceMode()` knows three planes; the cloud plane splits in two because
 * a cloud-managed ESP32 accepts a strictly narrower set of pushed settings
 * than a cloud-managed Linux frame, and `set_settings` refuses the WHOLE push
 * on the first key the device does not know. Rendering a field the device
 * cannot apply is therefore not a cosmetic slip: it takes the rest of the save
 * down with it.
 */
export type FrameSettingsSurface = 'backend' | 'frameAdmin' | 'cloudLinux' | 'cloudEsp32'

/** The surfaces a workspace mode can resolve to. */
export const surfacesForWorkspaceMode: Record<WorkspaceMode, readonly FrameSettingsSurface[]> = {
  backend: ['backend'],
  frameAdmin: ['frameAdmin'],
  cloud: ['cloudLinux', 'cloudEsp32'],
}

export function frameSettingsSurfaceFor(
  mode: WorkspaceMode = workspaceMode(),
  frame?: Parameters<typeof isEsp32CloudFrame>[0]
): FrameSettingsSurface {
  if (mode === 'cloud') {
    return isEsp32CloudFrame(frame, mode) ? 'cloudEsp32' : 'cloudLinux'
  }
  return mode
}

export interface FrameSettingsSectionSpec {
  /** Unique key. Two sections may share an `anchor` (the SSH heading does). */
  key: string
  /** Heading shown to the user, for orientation while reading this table. */
  title: string
  /**
   * The `id` on the section's <H6>, i.e. what the settings sub-navigation
   * scrolls to. `null` for a block with no heading of its own.
   */
  anchor: string | null
  /** The surfaces that render this section at all. */
  surfaces: readonly FrameSettingsSurface[]
  /**
   * The surfaces whose settings sub-navigation offers a link to `anchor`.
   * Defaults to `surfaces`. `[]` means "rendered, but deliberately not linked"
   * — say why in `navNote`.
   */
  nav?: readonly FrameSettingsSurface[]
  navNote?: string
  /**
   * Conditions BEYOND the surface, in prose. These stay in the component (they
   * depend on the frame's device, platform and reported firmware version); the
   * note is here so the whole gate can be read in one place.
   */
  conditions?: string
}

/**
 * Every section this panel can render, in render order, with the surfaces that
 * render it.
 *
 * This table is the panel's gate: `<FrameSettingsSection>` refuses to render a
 * section whose spec does not list the current surface, so a section cannot
 * appear on a plane by accident. It is also checked against
 * `allowedFrameSettingsSections` in workspaceSurfaces.ts — the settings
 * sub-navigation — by frame-settings-surface.test.ts, so a nav link can never
 * again point at a heading the panel does not draw, or a heading go unlinked
 * without an explicit note here.
 *
 * That drift is not hypothetical: the cloud's "SSH keys" section spent a
 * release inside the `!cloudProfile` branch, so the nav offered a link to an
 * anchor that only self-hosted frames rendered — and a cloud frame's SD-card
 * keys could not be edited at all.
 */
export const frameSettingsSections: readonly FrameSettingsSectionSpec[] = [
  {
    key: 'cloud-account',
    title: 'FrameOS Cloud',
    anchor: 'frame-settings-cloud',
    surfaces: ['frameAdmin'],
    conditions: 'Its own <form>, rendered above the frame form.',
  },
  {
    key: 'cloud-base',
    title: 'Frame settings (the pushable set)',
    anchor: 'frame-settings-info',
    surfaces: ['cloudLinux', 'cloudEsp32'],
    nav: [],
    navNote: 'The first thing the cloud panel renders, so a link to it scrolls nowhere.',
  },
  {
    key: 'cloud-defaults',
    title: 'Defaults',
    anchor: 'frame-settings-defaults',
    surfaces: ['cloudLinux'],
    conditions: 'Disabled, never hidden, below extendedCloudFrameSettingsMinVersion.',
  },
  {
    key: 'cloud-error-behavior',
    title: 'Global errors',
    anchor: 'frame-settings-error-behavior',
    surfaces: ['cloudLinux'],
    conditions: 'Same firmware floor as Defaults; both live in one <fieldset>.',
  },
  {
    key: 'cloud-qr',
    title: 'QR Control Code',
    anchor: 'frame-settings-qr',
    surfaces: ['cloudLinux'],
    conditions: 'Same firmware floor as Defaults.',
  },
  {
    key: 'cloud-hardware',
    title: 'Panel',
    anchor: 'frame-settings-hardware',
    surfaces: ['cloudLinux'],
    nav: [],
    navNote: 'Only some panels have a palette or partial refresh, so the heading is not always followed by a field.',
    conditions:
      'Disabled below hardwareCloudFrameSettingsMinVersion; palette and partial refresh depend on the panel the device reported.',
  },
  {
    key: 'cloud-hardware-gpio',
    title: 'GPIO buttons',
    anchor: 'frame-settings-gpio',
    surfaces: ['cloudLinux'],
    nav: [],
    navNote: 'Inside the Panel fieldset, which is itself unlinked.',
  },
  {
    key: 'cloud-esp32-power',
    title: 'Power',
    anchor: 'frame-settings-power',
    surfaces: ['cloudEsp32'],
    conditions:
      'The Pi runtime has no power keys in its allowlist, so pushing them at a Linux frame refuses the whole save.',
  },
  {
    key: 'cloud-esp32-extended',
    title: 'Device',
    anchor: 'frame-settings-esp32-extended',
    surfaces: ['cloudEsp32'],
    nav: [],
    navNote: 'The esp32 profile keeps a single nav entry (Power); see esp32CloudFrameSettingsSections.',
    conditions: 'Disabled below esp32ExtendedCloudFrameSettingsMinVersion.',
  },
  {
    key: 'cloud-esp32-gpio',
    title: 'GPIO buttons',
    anchor: 'frame-settings-gpio',
    surfaces: ['cloudEsp32'],
    nav: [],
    navNote: 'Inside the Device fieldset, which is itself unlinked.',
  },
  {
    key: 'cloud-service-settings',
    title: 'Service settings',
    anchor: 'frame-settings-service-settings',
    surfaces: ['cloudLinux', 'cloudEsp32'],
    nav: [],
    navNote: 'Account-level keys and per-scene grants, not a frame setting the nav indexes.',
  },
  {
    key: 'store-scene-service-settings',
    title: 'Service keys for store scenes',
    anchor: 'frame-settings-store-scene-services',
    surfaces: ['backend', 'frameAdmin'],
    conditions:
      'Renders only when a store scene is installed; the nav link is gated the same way (storeSceneOnlyFrameSettingsSections).',
  },
  {
    key: 'cloud-telemetry',
    title: 'Logs and metrics',
    anchor: 'frame-settings-telemetry',
    surfaces: ['cloudLinux', 'cloudEsp32'],
    nav: [],
    navNote: 'Absent on frames whose row carries no telemetry flag.',
  },
  {
    key: 'frame-info',
    title: 'Frame info',
    anchor: 'frame-settings-info',
    surfaces: ['backend', 'frameAdmin'],
    conditions: 'Needs a frame_host, or logs to read the last-seen IPs from.',
  },
  {
    key: 'frameos-upgrade',
    title: 'FrameOS upgrade',
    anchor: 'frame-settings-upgrade',
    surfaces: ['frameAdmin'],
  },
  {
    key: 'service-secrets',
    title: 'Service secrets',
    anchor: 'frame-settings-service-secrets',
    surfaces: ['frameAdmin'],
    nav: [],
    navNote: 'On-device only; the nav list for frameAdmin predates it.',
  },
  {
    key: 'device-settings',
    title: 'Device settings',
    anchor: 'frame-settings-device',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'virtual-frame',
    title: 'Virtual frame',
    anchor: 'frame-settings-virtual',
    surfaces: ['backend'],
    nav: [],
    navNote: 'Virtual frames only, and they are a small minority of the backend fleet.',
  },
  {
    key: 'embedded-power',
    title: 'Power',
    anchor: 'frame-settings-power',
    surfaces: ['backend'],
    conditions: 'Real ESP32 boards only: not virtual frames, not the pico family.',
  },
  {
    key: 'cloud-ssh-keys',
    title: 'SSH keys',
    anchor: 'frame-settings-ssh',
    surfaces: ['cloudLinux'],
    conditions: "The account's public keys, written into SD cards built for this frame. The cloud never logs in.",
  },
  {
    key: 'ssh',
    title: 'SSH (backend → frame)',
    anchor: 'frame-settings-ssh',
    surfaces: ['backend'],
    conditions: 'Embedded frames show only the Frame host field — there is no sshd on a microcontroller.',
  },
  {
    key: 'remote-agent',
    title: 'Remote control',
    anchor: 'frame-settings-agent',
    surfaces: ['backend'],
    conditions: 'Not on embedded frames.',
  },
  {
    key: 'backend-access',
    title: 'Backend access (frame → backend)',
    anchor: 'frame-settings-backend',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'http-api',
    title: 'HTTP API on frame',
    anchor: 'frame-http-api-section',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'frame-admin-panel',
    title: 'Frame admin panel',
    anchor: 'frame-settings-admin',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'https-proxy',
    title: 'HTTPS',
    anchor: 'frame-http-proxy-section',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'network',
    title: 'Network',
    anchor: 'frame-settings-network',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'mountpoints',
    title: 'Mountpoints',
    anchor: 'frame-settings-mountpoints',
    surfaces: ['backend', 'frameAdmin'],
    conditions:
      'Raspberry Pi OS only: a microcontroller has nothing to mount, and the Buildroot images ship no cifs-utils and no writable /etc/fstab (`frameos setup` skips the step there too).',
  },
  {
    key: 'defaults',
    title: 'Defaults',
    anchor: 'frame-settings-defaults',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'error-behavior',
    title: 'Global errors',
    anchor: 'frame-settings-error-behavior',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'palette',
    title: 'Palette',
    anchor: 'frame-settings-palette',
    surfaces: ['backend', 'frameAdmin'],
    conditions: 'The heading always renders; panels without a palette get a line saying so.',
  },
  {
    key: 'qr',
    title: 'QR Control Code',
    anchor: 'frame-settings-qr',
    surfaces: ['backend', 'frameAdmin'],
  },
  {
    key: 'assets',
    title: 'Assets',
    anchor: 'frame-settings-assets',
    surfaces: ['backend', 'frameAdmin'],
    conditions: 'A full host OS only.',
  },
  {
    key: 'logs',
    title: 'Logs',
    anchor: 'frame-settings-logs',
    surfaces: ['backend', 'frameAdmin'],
    conditions: 'A full host OS only.',
  },
  {
    key: 'reboot',
    title: 'Reboot',
    anchor: 'frame-settings-reboot',
    surfaces: ['backend'],
    conditions:
      'A full host OS only. The cron line is written by a backend full deploy (/etc/cron.d/frameos-reboot); the runtime never reads it, so the on-device page has nothing to apply it with — a scheduled restart/reboot event on the Schedule panel is the device-side equivalent.',
  },
  {
    key: 'gpio',
    title: 'GPIO buttons',
    anchor: 'frame-settings-gpio',
    surfaces: ['backend', 'frameAdmin'],
  },
]

const specsByKey = new Map(frameSettingsSections.map((section) => [section.key, section]))

export function frameSettingsSectionSpec(key: string): FrameSettingsSectionSpec {
  const spec = specsByKey.get(key)
  if (!spec) {
    throw new Error(`Unknown frame settings section: ${key}`)
  }
  return spec
}

/** Whether the section may render on this surface. The panel's only gate. */
export function frameSettingsSectionRenders(key: string, surface: FrameSettingsSurface): boolean {
  return frameSettingsSectionSpec(key).surfaces.includes(surface)
}

/**
 * The anchors this table says the settings sub-navigation should offer in a
 * given workspace mode — what `allowedFrameSettingsSections[mode]` must equal.
 */
export function frameSettingsNavAnchorsForMode(mode: WorkspaceMode): string[] {
  const surfaces = surfacesForWorkspaceMode[mode]
  const anchors = new Set<string>()
  for (const section of frameSettingsSections) {
    if (!section.anchor) {
      continue
    }
    const linked = section.nav ?? section.surfaces
    if (linked.some((surface) => surfaces.includes(surface))) {
      anchors.add(section.anchor)
    }
  }
  return [...anchors]
}

/**
 * The nav list this table implies, in the order workspaceSurfaces declares it.
 * Exported for the mirror test and for anyone regenerating that list by hand.
 */
export function frameSettingsNavDrift(mode: WorkspaceMode): { missing: string[]; extra: string[] } {
  const expected = new Set(frameSettingsNavAnchorsForMode(mode))
  const declared = new Set(allowedFrameSettingsSections[mode])
  return {
    missing: [...expected].filter((anchor) => !declared.has(anchor)),
    extra: [...declared].filter((anchor) => !expected.has(anchor)),
  }
}

/** Convenience for callers that hold a full frame rather than the capability shape. */
export function frameSettingsSurfaceForFrame(frame: FrameType | null | undefined): FrameSettingsSurface {
  return frameSettingsSurfaceFor(workspaceMode(), frame)
}
