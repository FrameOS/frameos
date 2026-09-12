import { describe, expect, it } from 'vitest'
import {
  upgradeBuildLabel,
  upgradeHostLabel,
} from '../../../../../../frontend/src/scenes/frame/panels/FrameSettings/frameSettingsHelpers'

// The "FrameOS upgrade" card on a frame's settings page. `target` is the
// release tarball slug the device downloads; on a Buildroot image that reads
// `debian-bookworm-<arch>` even though the device runs no Debian and has no
// apt. The card therefore leads with the host OS the runtime reports and
// shows only the arch as the build, keeping the slug in a hint.
describe('frame upgrade card labels', () => {
  it('shows a Buildroot image as FrameOS with only the arch, and keeps the slug as a hint', () => {
    const status = {
      target: 'debian-bookworm-arm64',
      host: { id: 'buildroot', name: 'FrameOS system image (Buildroot)', version: '2025.02.13', arch: 'arm64' },
    }
    expect(upgradeHostLabel(status)).toBe('FrameOS system image (Buildroot) 2025.02.13')
    const build = upgradeBuildLabel(status)
    expect(build.label).toBe('arm64')
    expect(build.hint).toContain('debian-bookworm-arm64')
    expect(build.hint).toContain('no package manager')
  })

  it('keeps the distro release on Debian and Ubuntu hosts, where it picks the binary', () => {
    const status = {
      target: 'debian-trixie-armhf',
      host: { id: 'debian', name: 'Debian GNU/Linux 13 (trixie)', version: '13', arch: 'armhf' },
    }
    expect(upgradeHostLabel(status)).toBe('Debian GNU/Linux 13 (trixie)')
    expect(upgradeBuildLabel(status)).toEqual({ label: 'debian-trixie-armhf' })
  })

  it('falls back to the arch in the slug when the runtime reports no arch', () => {
    expect(upgradeBuildLabel({ target: 'debian-bookworm-armv6', host: { id: 'buildroot' } }).label).toBe('armv6')
  })

  it('reads as unknown without a target and hides the OS row on releases without a host field', () => {
    expect(upgradeBuildLabel(null)).toEqual({ label: 'Unknown' })
    expect(upgradeBuildLabel({ target_error: 'Cannot read /etc/os-release' })).toEqual({ label: 'Unknown' })
    expect(upgradeHostLabel({ target: 'debian-bookworm-arm64' })).toBeUndefined()
    expect(upgradeHostLabel({ host: { id: 'debian', name: '  ' } })).toBeUndefined()
  })
})
