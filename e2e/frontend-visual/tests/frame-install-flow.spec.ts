import { expect, Page, Route, test } from '@playwright/test'
import { cleanupE2EInstallFrames, login } from './visual-helpers'

interface CreatedFrame {
  id: number
  name: string
  frame_host: string
  server_api_key: string
}

const e2eScene = {
  id: 'e2e-render-scene',
  name: 'E2E render scene',
  nodes: [
    {
      id: 'e2e-render-event',
      type: 'event',
      position: { x: 0, y: 0 },
      data: { keyword: 'render' },
    },
  ],
  edges: [],
  fields: [],
  settings: { execution: 'interpreted', refreshInterval: 300 },
}

test.describe.serial('@e2e frame installation setup flow', () => {
  test.beforeEach(async ({ page }) => {
    await installE2ERoutes(page)
    await login(page)
    await cleanupE2EInstallFrames(page)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /Add frame/i }).first()).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    await cleanupE2EInstallFrames(page)
  })

  test('download SD card image boots and renders @e2e', async ({ page }) => {
    const frame = await addFrame(page, {
      method: 'Download SD card',
      name: uniqueName('SD card'),
      wifi: true,
    })

    await expect(
      page.locator('.workspace-drawer').last().getByRole('button', { name: /Build \/ download SD card/i })
    ).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Build \/ download SD card/i }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename().length).toBeGreaterThan(0)

    await simulateFrameRender(page, frame)
    await expectRenderDoneLog(page, frame.id)
  })

  test('install over SSH deploys and renders @e2e', async ({ page }) => {
    const frame = await addFrame(page, {
      method: 'Install over SSH',
      name: uniqueName('SSH'),
      sshConnection: 'pi:raspberry@127.0.0.1',
    })

    await runFullDeploy(page)
    await simulateFrameRender(page, frame)
    await expectRenderDoneLog(page, frame.id)
  })

  test('install with a script connects back and renders @e2e', async ({ page }) => {
    const frame = await addFrame(page, {
      method: 'Install with a script',
      name: uniqueName('Script'),
    })

    const drawer = page.locator('.workspace-drawer').last()
    await expect(drawer.getByText('Install with a script')).toBeVisible()
    await expect(drawer.getByText('FRAMEOS_E2E_INSTALL=1')).toBeVisible()
    await drawer.getByRole('button', { name: /Copy command/i }).click()
    await expect(drawer.getByRole('button', { name: /Copied/i })).toBeVisible()

    await simulateFrameRender(page, frame)
    await expectRenderDoneLog(page, frame.id)
  })

  test('import frame deploys and renders @e2e', async ({ page }) => {
    const frame = await importFrame(page, uniqueName('Import'))

    await runFullDeploy(page)
    await simulateFrameRender(page, frame)
    await expectRenderDoneLog(page, frame.id)
  })
})

async function installE2ERoutes(page: Page): Promise<void> {
  await page.route(/\/api\/frames\/\d+\/deploy_plan(?:\?.*)?$/, async (route) => {
    const frameId = frameIdFromUrl(route)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ plan: deployPlan(frameId) }),
    })
  })

  await page.route(/\/api\/frames\/\d+\/(?:fast_deploy|deploy)$/, fulfillText('Success'))

  await page.route(/\/api\/frames\/\d+\/buildroot\/sd_image$/, async (route) => {
    const frameId = frameIdFromUrl(route)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'E2E SD card image ready',
        sdImage: {
          status: 'ready',
          platform: 'raspberry-pi-zero-2-w',
          filename: `frameos-e2e-${frameId}.img.gz`,
          downloadUrl: `/api/frames/${frameId}/buildroot/sd_image/download`,
        },
      }),
    })
  })

  await page.route(/\/api\/frames\/\d+\/buildroot\/sd_image\/download$/, async (route) => {
    const frameId = frameIdFromUrl(route)
    await route.fulfill({
      status: 200,
      contentType: 'application/gzip',
      headers: {
        'content-disposition': `attachment; filename="frameos-e2e-${frameId}.img.gz"`,
      },
      body: Buffer.from(`frameos-e2e-image-${frameId}`),
    })
  })

  await page.route(
    /\/api\/frames\/\d+\/frame_bootstrap(?:\?.*)?$/,
    fulfillJson({
      command: 'sudo FRAMEOS_E2E_INSTALL=1 /bin/sh -c "echo installing frameos"',
    })
  )

  await page.route(
    /\/api\/frames\/\d+\/(?:state|states|uploaded_scenes)(?:\?.*)?$/,
    fulfillJson({
      sceneId: e2eScene.id,
      state: {},
      states: { [e2eScene.id]: {} },
      scenes: [{ id: e2eScene.id, name: e2eScene.name }],
    })
  )
}

async function addFrame(
  page: Page,
  options: {
    method: 'Download SD card' | 'Install over SSH' | 'Install with a script'
    name: string
    sshConnection?: string
    wifi?: boolean
  }
): Promise<CreatedFrame> {
  const drawer = await openAddFrameDrawer(page)
  await drawer.getByRole('button', { name: new RegExp(options.method, 'i') }).click()
  await drawer.getByLabel('Name', { exact: true }).fill(options.name)

  if (options.sshConnection) {
    await drawer.getByLabel('SSH connection string', { exact: true }).fill(options.sshConnection)
  }
  if (options.wifi) {
    await drawer.getByLabel('WiFi network', { exact: true }).fill('FrameOS-E2E')
    await drawer.getByLabel('WiFi password', { exact: true }).fill('frameos-e2e-password')
  }

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/frames/new') && response.request().method() === 'POST'
  })
  await drawer.getByRole('button', { name: 'Add frame' }).click()
  const response = await responsePromise
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const frame = payload.frame as CreatedFrame
  expect(frame.name).toBe(options.name)
  await expect(page.getByText(options.name).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Deploy' })).toBeVisible()
  return frame
}

async function importFrame(page: Page, name: string): Promise<CreatedFrame> {
  const drawer = await openAddFrameDrawer(page)
  await drawer.getByRole('button', { name: /Import frame/i }).click()

  await drawer.locator('input[type="file"]').setInputFiles({
    name: 'frameos-import-e2e.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name,
        frame_host: 'import-e2e.local',
        server_host: '127.0.0.1:8989',
        device: 'web_only',
        interval: 300,
        mode: 'rpios',
        scenes: [e2eScene],
        agent: { agentEnabled: false, agentRunCommands: false, deployWithAgent: false },
      })
    ),
  })

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/frames/import') && response.request().method() === 'POST'
  })
  await drawer.getByRole('button', { name: 'Import', exact: true }).click()
  const response = await responsePromise
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const frame = payload.frame as CreatedFrame
  expect(frame.name).toBe(name)
  await expect(page.getByText(name).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Deploy' })).toBeVisible()
  return frame
}

async function runFullDeploy(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Deploy' })).toBeVisible()
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return /\/api\/frames\/\d+\/deploy$/.test(url.pathname) && response.request().method() === 'POST'
  })
  await page.getByRole('button', { name: 'Full deploy' }).click()
  const response = await responsePromise
  expect(response.ok()).toBeTruthy()
}

async function simulateFrameRender(page: Page, frame: CreatedFrame): Promise<void> {
  const logs = [
    { event: 'bootup', width: 800, height: 480, color: 'full' },
    { event: 'render', sceneId: e2eScene.id },
    { event: 'render:device', sceneId: e2eScene.id },
    { event: 'render:done', sceneId: e2eScene.id, width: 800, height: 480 },
  ]

  for (const log of logs) {
    const response = await page.request.post('/api/log', {
      headers: { Authorization: `Bearer ${frame.server_api_key}` },
      data: { log },
    })
    expect(response.ok()).toBeTruthy()
  }
}

async function expectRenderDoneLog(page: Page, frameId: number): Promise<void> {
  const logsResponse = await page.request.get(`/api/frames/${frameId}/logs`)
  expect(logsResponse.ok()).toBeTruthy()
  const logsPayload = await logsResponse.json()
  expect(
    logsPayload.logs.some(
      (log: { type: string; line: string }) => log.type === 'webhook' && log.line.includes('render:done')
    )
  ).toBeTruthy()

  await page.goto(`/frames/${frameId}?tool=logs`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('Search logs...').fill('render:done')
  await expect(page.getByText('render:done')).toBeVisible()
}

function deployPlan(frameId: number): Record<string, unknown> {
  return {
    mode: 'combined',
    frame_id: frameId,
    frame_name: `E2E frame ${frameId}`,
    build_id: `e2e-${frameId}`,
    previous_frameos_version: null,
    notes: [],
    fast_deploy: {
      reload_supported: true,
      tls_settings_changed: false,
      action: 'reload',
    },
    full_deploy: {
      target: {
        arch: 'aarch64',
        distro: 'Raspberry Pi OS',
        version: '12',
        total_memory_mb: 1024,
      },
      low_memory: false,
      drivers: ['web_only'],
      binary: {
        requested_compilation_mode: 'precompiled',
        compilation_mode: 'shared-scenes',
        will_attempt_cross_compile: false,
        will_attempt_precompiled: true,
        cross_compile_supported: true,
        build_host_configured: false,
        prebuilt_target: 'linux-arm64',
        has_prebuilt_entry: true,
        precompiled_release_url: null,
        precompiled_skip_reason: null,
      },
      packages: [],
      package_alternatives: [],
      lgpio: { required: false, installed: true },
      quickjs: { required_if_remote_build: false, dirname: null, installed: true },
      ssh_keys_need_install: false,
      post_deploy: { final_action: 'restart_frameos' },
    },
  }
}

async function openAddFrameDrawer(page: Page) {
  await page.getByRole('button', { name: /Add frame/i }).first().click()
  const installationDrawer = page.locator('.workspace-drawer').filter({ hasText: /Installation method/i }).last()
  await expect(installationDrawer).toBeVisible()
  await expect(installationDrawer.getByRole('button', { name: /Download SD card/i })).toBeVisible()
  const drawer = page.locator('.workspace-drawer').last()
  return drawer
}

function frameIdFromUrl(route: Route): number {
  const match = new URL(route.request().url()).pathname.match(/\/api\/frames\/(\d+)\//)
  return Number(match?.[1] ?? 0)
}

function uniqueName(prefix: string): string {
  return `E2E install flow ${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fulfillJson(body: unknown): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
}

function fulfillText(body: string): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body,
    })
}
