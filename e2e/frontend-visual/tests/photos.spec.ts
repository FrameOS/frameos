import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { deflateSync } from 'zlib'
import { attachFrontendErrorCollector, currentProjectApiPath, login, prepareStablePage } from './visual-helpers'

// The Photos library against the real backend: the albums live on disk under
// FRAMEOS_PHOTOS_DIR (scripts/start-backend.sh points it at a wiped folder in
// .tmp), so every test here leaves the library the way it found it. Albums
// made here carry a unique prefix, and "2024" is the one name the URL test
// needs verbatim: both are cleaned up before the first test and after the last.
const albumPrefix = 'E2E photos'
const numericAlbum = '2024'
const albumName = `${albumPrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const photoName = 'e2e-photo.png'
const renamedPhotoName = 'e2e-renamed.png'
const seededFrameName = 'Kitchen dashboard'

function isE2EAlbum(name: string): boolean {
  return name.startsWith(`${albumPrefix} `) || name === numericAlbum
}

function tileFor(page: Page, path: string) {
  return page.locator(`[data-photo-path="${path}"]`)
}

async function photosApiPath(page: Page, suffix: string): Promise<string> {
  return currentProjectApiPath(page, `/api/photos${suffix}`)
}

async function cleanupE2EAlbums(page: Page): Promise<void> {
  const response = await page.request.get(await photosApiPath(page, '/files?path='))
  if (!response.ok()) {
    throw new Error(`Could not list the photo library for cleanup: ${response.status()}`)
  }
  const payload = await response.json()
  const paths = (Array.isArray(payload?.entries) ? payload.entries : [])
    .filter((entry: { kind: string; name: string }) => entry.kind === 'folder' && isE2EAlbum(entry.name))
    .map((entry: { path: string }) => entry.path)
  if (paths.length) {
    const deleteResponse = await page.request.post(await photosApiPath(page, '/delete'), { data: { paths } })
    if (!deleteResponse.ok()) {
      throw new Error(`Could not delete E2E albums: ${deleteResponse.status()}`)
    }
  }
}

async function openPhotos(page: Page, folder?: string): Promise<void> {
  const url = folder ? `/photos?${new URLSearchParams({ folder }).toString()}` : '/photos'
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // The breadcrumb bar is only drawn once the library answered its status.
  await expect(page.getByRole('navigation', { name: 'Folder' })).toBeVisible()
}

// Modals are Headless UI dialogs: the role="dialog" root has no box of its
// own, so "open" is its title heading being visible.
async function expectModalOpen(page: Page, title: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible()
  return dialog
}

function expectNoFrontendErrors(readErrors: () => string[]): void {
  const errors = [...new Set(readErrors())]
  expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
}

// A valid PNG made here, so the test needs no fixture file: `width` x `height`
// pixels of one color, 8-bit RGB, no filter.
function tinyPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return c >>> 0
  })
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // color type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test.describe.serial('@e2e photos library', () => {
  let readErrors: () => string[]

  test.beforeEach(async ({ page }) => {
    readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await prepareStablePage(page, 'light')
    await login(page)
  })

  test.afterEach(() => {
    expectNoFrontendErrors(readErrors)
  })

  test.afterAll(async () => {
    const baseURL = test.info().project.use.baseURL
    const context: APIRequestContext = await playwrightRequest.newContext({ baseURL })
    try {
      const loginResponse = await context.post('/api/login', {
        form: { username: 'visual@example.com', password: 'visual-password' },
      })
      if (!loginResponse.ok()) {
        return
      }
      const projects = await (await context.get('/api/projects')).json()
      const projectId = projects?.projects?.[0]?.id
      const listing = await (await context.get(`/api/projects/${projectId}/photos/files?path=`)).json()
      const paths = (Array.isArray(listing?.entries) ? listing.entries : [])
        .filter((entry: { kind: string; name: string }) => entry.kind === 'folder' && isE2EAlbum(entry.name))
        .map((entry: { path: string }) => entry.path)
      if (paths.length) {
        await context.post(`/api/projects/${projectId}/photos/delete`, { data: { paths } })
      }
    } finally {
      await context.dispose()
    }
  })

  test('an empty library makes an album @e2e', async ({ page }) => {
    await cleanupE2EAlbums(page)
    await openPhotos(page)

    await expect(page.getByText('No albums yet. Make one to start.')).toBeVisible()
    await expect(page.getByText('No photos yet')).toBeVisible()

    // The empty state's own button; the sidebar has a second one (aria-label "New album").
    await page.getByRole('button', { name: 'New album', exact: true }).first().click()
    const dialog = await expectModalOpen(page, 'New album')
    await dialog.getByLabel('Name').fill(albumName)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByRole('link', { name: new RegExp(albumName) })).toBeVisible()
    await expect(tileFor(page, albumName)).toBeVisible()
    await expect(tileFor(page, albumName)).toContainText('0 files')

    await page.getByRole('link', { name: new RegExp(albumName) }).click()
    await expect(page.getByRole('navigation', { name: 'Folder' })).toContainText(albumName)
    await expect(page.getByText('This folder is empty')).toBeVisible()
    await expect(page).toHaveURL(/\/photos\?folder=/)
  })

  test('uploads a photo through the file input and shows its thumbnail @e2e', async ({ page }) => {
    await openPhotos(page, albumName)
    await expect(page.getByText('This folder is empty')).toBeVisible()

    // The Upload button clicks a hidden <input type="file">; setInputFiles
    // drives that input directly.
    await page.locator('input[type="file"]').setInputFiles({
      name: photoName,
      mimeType: 'image/png',
      buffer: tinyPng(16, 12, [220, 38, 38]),
    })

    await expect(page.getByText('1 uploaded', { exact: true })).toBeVisible()
    const tile = tileFor(page, `${albumName}/${photoName}`)
    await expect(tile).toBeVisible()
    await expect(tile).toContainText('16×12')

    const thumbnail = tile.locator('img')
    await expect(thumbnail).toBeVisible()
    await expect
      .poll(() => thumbnail.evaluate((img) => (img as HTMLImageElement).naturalWidth), {
        message: 'the thumbnail <img> never loaded',
      })
      .toBeGreaterThan(0)

    const listing = await page.request.get(
      await photosApiPath(page, `/files?${new URLSearchParams({ path: albumName }).toString()}`)
    )
    expect(listing.ok()).toBeTruthy()
    const entries = (await listing.json()).entries
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual([photoName])
    expect(entries[0]).toMatchObject({ kind: 'file', width: 16, height: 12, content_type: 'image/png' })
  })

  test('opens the lightbox and Escape closes it @e2e', async ({ page }) => {
    await openPhotos(page, albumName)
    const tile = tileFor(page, `${albumName}/${photoName}`)
    await expect(tile).toBeVisible()

    // A plain click opens; selecting is the tick in the tile's corner.
    await tile.click()
    const lightbox = page.getByRole('dialog', { name: photoName })
    await expect(lightbox).toBeVisible()
    await expect(lightbox).toContainText('1 of 1')
    await expect(lightbox.locator('img')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(lightbox).toBeHidden()
    await expect(tile).toBeVisible()
  })

  test('renames the photo from the selection bar @e2e', async ({ page }) => {
    await openPhotos(page, albumName)
    const tile = tileFor(page, `${albumName}/${photoName}`)
    await expect(tile).toBeVisible()

    await tile.hover()
    await tile.getByRole('button', { name: `Select ${photoName}` }).click()
    await expect(page.getByText('1 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Rename' }).click()

    const dialog = await expectModalOpen(page, 'Rename')
    await expect(dialog.getByLabel('Name')).toHaveValue(photoName)
    await dialog.getByLabel('Name').fill(renamedPhotoName)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).toBeHidden()

    await expect(tileFor(page, `${albumName}/${renamedPhotoName}`)).toBeVisible()
    await expect(tile).toHaveCount(0)
  })

  test('shares the album and the link answers without a session @e2e', async ({ page, request }) => {
    await openPhotos(page, albumName)
    await expect(tileFor(page, `${albumName}/${renamedPhotoName}`)).toBeVisible()

    await page.locator('.photos-topbar').getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Share link' }).click()

    const dialog = await expectModalOpen(page, `Share "${albumName}"`)
    await dialog.getByRole('button', { name: 'Create link' }).click()

    const linkInput = dialog.locator('input[readonly]')
    await expect(linkInput).toBeVisible()
    const link = await linkInput.inputValue()
    expect(link).toMatch(/^https?:\/\/.+\/api\/photos\/shared\/pk_[A-Za-z0-9_-]{32,}$/)
    await expect(dialog.getByRole('button', { name: 'Stop sharing' })).toBeVisible()

    // With the modal closed the sidebar marks the album as shared (the icon
    // is aria-hidden, so by attribute).
    await dialog.getByRole('button', { name: '×' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('link', { name: new RegExp(albumName) }).locator('[aria-label="Shared"]')).toBeVisible()

    // `request` is a fresh context with no session cookie: the token is the credential.
    const shared = await request.get(link)
    expect(shared.status()).toBe(200)
    const payload = await shared.json()
    expect(payload.name).toBe(albumName)
    expect(payload.count).toBe(1)
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]).toMatchObject({ path: renamedPhotoName, name: renamedPhotoName, width: 16, height: 12 })

    const photo = await request.get(`${link}/photo?order=sequential&index=0`)
    expect(photo.status()).toBe(200)
    expect((await photo.json()).photo?.name).toBe(renamedPhotoName)

    const file = await request.get(`${link}/file?${new URLSearchParams({ path: renamedPhotoName }).toString()}`)
    expect(file.status()).toBe(200)
    expect(file.headers()['content-type']).toContain('image/png')

    const missing = await request.get(link.replace(/pk_[A-Za-z0-9_-]+$/, 'pk_e2e-no-such-token-0000000000000000'))
    expect(missing.status()).toBe(404)
  })

  test('opens an album named 2024 from the URL @e2e', async ({ page }) => {
    // kea-router parses "2024" in the query as a number; the page must still
    // read it as the folder's name.
    const created = await page.request.post(await photosApiPath(page, '/folders'), { data: { path: numericAlbum } })
    expect(created.ok()).toBeTruthy()

    await openPhotos(page, numericAlbum)
    const breadcrumbs = page.getByRole('navigation', { name: 'Folder' })
    await expect(breadcrumbs.getByRole('link', { name: numericAlbum, exact: true })).toBeVisible()
    await expect(page.getByText('This folder is empty')).toBeVisible()
    await expect(page.getByText('Nothing here matches')).toHaveCount(0)

    const deleted = await page.request.post(await photosApiPath(page, '/delete'), { data: { paths: [numericAlbum] } })
    expect(deleted.ok()).toBeTruthy()
  })

  test('install on frame installs the album as a saved scene and opens it @e2e', async ({ page }) => {
    await openPhotos(page, albumName)
    await expect(tileFor(page, `${albumName}/${renamedPhotoName}`)).toBeVisible()

    await page.getByTitle('Make scenes that play albums on a frame').click()
    const picker = await expectModalOpen(page, 'Install on frame')
    await expect(picker).toContainText(`Pick the frame that plays "${albumName}"`)
    await picker.getByRole('button', { name: seededFrameName }).click()

    // Picking the frame is the install: the scene is added, the frame saved,
    // and the new scene's drawer opens — no second Install click.
    await expect(page).toHaveURL(/\/frames\/1\?(?=.*\bdrawer=scene\b)(?=.*\bsceneId=)/)
    const drawer = page.locator('.workspace-drawer').last()
    await expect(drawer.getByRole('heading', { name: albumName })).toBeVisible()
    await expect(page.getByText('unsaved changes')).toHaveCount(0)

    const frame = await page.request.get(await currentProjectApiPath(page, '/api/frames/1'))
    expect(frame.ok()).toBeTruthy()
    const scenes = ((await frame.json()).frame?.scenes ?? []) as { id: string; name: string }[]
    const installed = scenes.filter((scene) => scene.name === albumName)
    expect(installed).toHaveLength(1)
    await expect(page).toHaveURL(new RegExp(`sceneId=${installed[0].id}`))
  })

  test('deletes the album after a confirmation and leaves the library empty @e2e', async ({ page }) => {
    await openPhotos(page)
    const tile = tileFor(page, albumName)
    await expect(tile).toBeVisible()

    await tile.hover()
    await tile.getByRole('button', { name: `Select ${albumName}` }).click()
    await expect(page.getByText('1 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Delete' }).click()

    const confirm = await expectModalOpen(page, `Delete "${albumName}"?`)
    await expect(confirm).toContainText('Folders are deleted with everything in them')
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await expect(confirm).toBeHidden()

    await expect(tile).toHaveCount(0)
    await expect(page.getByText('No albums yet. Make one to start.')).toBeVisible()
    await expect(page.getByText('No photos yet')).toBeVisible()

    const listing = await page.request.get(await photosApiPath(page, '/files?path='))
    expect(listing.ok()).toBeTruthy()
    const names = (await listing.json()).entries.map((entry: { name: string }) => entry.name)
    expect(names.filter(isE2EAlbum)).toEqual([])
  })
})
