import { v4 as uuidv4 } from 'uuid'
import type { FrameScene } from '../../types'
import { embeddedRepoAppConfigs, embeddedRepoAppSources } from '../../generated/repoApps'
import { buildSceneApp } from '../../utils/sceneApps'

export const PHOTO_ALBUM_APP_ORIGIN = 'repo/apps/image/photoAlbum'
const PHOTO_ALBUM_APP_KEY = 'photoAlbum'

export type PhotoAlbumOrder = 'random' | 'sequential' | 'newest' | 'oldest'
export type PhotoAlbumFit = 'cover' | 'contain'
/** A photo is landscape, portrait or square by its pixels (docs/photos.md, the share routes' `shapes`). */
export type PhotoAlbumShape = 'landscape' | 'portrait' | 'square'

export const PHOTO_ALBUM_ORDERS: { value: PhotoAlbumOrder; label: string }[] = [
  { value: 'random', label: 'Shuffle' },
  { value: 'sequential', label: 'By name' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
]

export const PHOTO_ALBUM_FITS: { value: PhotoAlbumFit; label: string }[] = [
  { value: 'cover', label: 'Fill the screen' },
  { value: 'contain', label: 'Show the whole photo' },
]

/** The scene's three shape toggles, one boolean field each, in field order. */
export const PHOTO_ALBUM_SHAPES: { value: PhotoAlbumShape; label: string }[] = [
  { value: 'landscape', label: 'Landscape photos' },
  { value: 'portrait', label: 'Portrait photos' },
  { value: 'square', label: 'Square photos' },
]

export const ALL_PHOTO_ALBUM_SHAPES: PhotoAlbumShape[] = PHOTO_ALBUM_SHAPES.map((shape) => shape.value)

/** `shapes` as the scene bodies and share routes take them: known names, in order, no repeats. */
export function normalizePhotoAlbumShapes(shapes: readonly string[] | null | undefined): PhotoAlbumShape[] {
  return ALL_PHOTO_ALBUM_SHAPES.filter((shape) => (shapes ?? ALL_PHOTO_ALBUM_SHAPES).includes(shape))
}

export interface PhotoAlbumSceneOptions {
  name: string
  /** The share link the frame plays (docs/photos.md, "Share routes"). */
  albumUrl: string
  seconds: number
  order: PhotoAlbumOrder
  fit: PhotoAlbumFit
  /** The shapes the scene plays; every shape when left out. */
  shapes?: readonly PhotoAlbumShape[]
  backgroundColor?: string
  /** One photo of the album, by its path relative to the folder: the scene shows it alone. */
  photo?: string
}

/** A scene that shows one photo of an album per render: render event →
 * render/image fed by the photoAlbum app, then sleep for `seconds`. The link
 * sits in the app node's config, out of the public state. The backend and the
 * cloud build the same scene for `POST /api/photos/scene`;
 * docs/photo-album-scene.json pins all three. */
export function buildPhotoAlbumScene(options: PhotoAlbumSceneOptions): FrameScene {
  const sources = embeddedRepoAppSources[PHOTO_ALBUM_APP_ORIGIN]
  if (!sources) {
    throw new Error('The Photo album app is missing from this build.')
  }
  const seconds = Number.isFinite(options.seconds) && options.seconds > 0 ? options.seconds : 3600
  const shapes = options.shapes ?? ALL_PHOTO_ALBUM_SHAPES
  const ids = {
    event: uuidv4(),
    renderImage: uuidv4(),
    album: uuidv4(),
    sleep: uuidv4(),
    seconds: uuidv4(),
    order: uuidv4(),
    fit: uuidv4(),
    landscape: uuidv4(),
    portrait: uuidv4(),
    square: uuidv4(),
  }
  const node = (id: string, type: string, data: Record<string, any>, x: number, y: number) => ({
    id,
    type,
    data,
    position: { x, y },
  })
  const edge = (source: string, sourceHandle: string, target: string, targetHandle: string, type: string) => ({
    id: uuidv4(),
    source,
    sourceHandle,
    target,
    targetHandle,
    type,
  })

  // One photo: nothing to shuffle through and no interval to pick, so the
  // scene keeps only the fit; the scene's own refresh interval re-renders it.
  if (options.photo) {
    return {
      id: uuidv4(),
      name: options.name,
      settings: {
        backgroundColor: options.backgroundColor ?? '#000000',
        refreshInterval: seconds,
        execution: 'interpreted',
      },
      fields: [
        {
          name: 'fit',
          label: 'Fit',
          type: 'select',
          options: PHOTO_ALBUM_FITS.map(({ value, label }) => ({ value, label })),
          persist: 'disk',
          access: 'public',
          value: options.fit,
        },
      ],
      nodes: [
        node(ids.event, 'event', { keyword: 'render' }, -320, 120),
        node(ids.renderImage, 'app', { keyword: 'render/image', config: {} }, 200, 140),
        node(
          ids.album,
          'app',
          {
            keyword: PHOTO_ALBUM_APP_KEY,
            config: { album: options.albumUrl, photo: options.photo },
            cache: { enabled: false },
          },
          -260,
          -200
        ),
        node(ids.fit, 'state', { keyword: 'fit' }, 120, 40),
      ],
      edges: [
        edge(ids.event, 'next', ids.renderImage, 'prev', 'appNodeEdge'),
        edge(ids.album, 'fieldOutput', ids.renderImage, 'fieldInput/image', 'codeNodeEdge'),
        edge(ids.fit, 'fieldOutput', ids.renderImage, 'fieldInput/placement', 'codeNodeEdge'),
      ],
      apps: {
        [PHOTO_ALBUM_APP_KEY]: buildSceneApp(
          PHOTO_ALBUM_APP_KEY,
          embeddedRepoAppConfigs[PHOTO_ALBUM_APP_ORIGIN],
          sources,
          {
            origin: PHOTO_ALBUM_APP_ORIGIN,
          }
        ),
      },
    } as FrameScene
  }

  return {
    id: uuidv4(),
    name: options.name,
    settings: {
      backgroundColor: options.backgroundColor ?? '#000000',
      refreshInterval: seconds,
      execution: 'interpreted',
    },
    fields: [
      {
        name: 'seconds',
        role: 'refreshInterval',
        label: 'Seconds to show one photo',
        type: 'float',
        persist: 'disk',
        access: 'public',
        value: String(seconds),
      },
      {
        name: 'order',
        label: 'Order',
        type: 'select',
        // Labeled, so the scene's controls say "Shuffle", not "random".
        options: PHOTO_ALBUM_ORDERS.map(({ value, label }) => ({ value, label })),
        persist: 'disk',
        access: 'public',
        value: options.order,
      },
      {
        name: 'fit',
        label: 'Fit',
        type: 'select',
        options: PHOTO_ALBUM_FITS.map(({ value, label }) => ({ value, label })),
        persist: 'disk',
        access: 'public',
        value: options.fit,
      },
      ...PHOTO_ALBUM_SHAPES.map((shape) => ({
        name: shape.value,
        label: shape.label,
        type: 'boolean' as const,
        persist: 'disk' as const,
        access: 'public' as const,
        value: shapes.includes(shape.value) ? 'true' : 'false',
      })),
      {
        name: 'photoIndex',
        label: 'Position in the album',
        type: 'integer',
        persist: 'disk',
        access: 'private',
        value: '0',
      },
    ],
    nodes: [
      node(ids.event, 'event', { keyword: 'render' }, -320, 120),
      node(ids.renderImage, 'app', { keyword: 'render/image', config: {} }, 200, 140),
      node(
        ids.album,
        'app',
        {
          keyword: PHOTO_ALBUM_APP_KEY,
          config: { album: options.albumUrl, counterStateKey: 'photoIndex' },
          cache: { enabled: false },
        },
        -260,
        -200
      ),
      node(ids.sleep, 'app', { keyword: 'logic/nextSleepDuration', config: {} }, 640, 140),
      node(ids.seconds, 'state', { keyword: 'seconds' }, 560, 40),
      node(ids.order, 'state', { keyword: 'order' }, -520, -140),
      ...PHOTO_ALBUM_SHAPES.map((shape, position) =>
        node(ids[shape.value], 'state', { keyword: shape.value }, -520, -60 + 80 * position)
      ),
      node(ids.fit, 'state', { keyword: 'fit' }, 120, 40),
    ],
    edges: [
      edge(ids.event, 'next', ids.renderImage, 'prev', 'appNodeEdge'),
      edge(ids.album, 'fieldOutput', ids.renderImage, 'fieldInput/image', 'codeNodeEdge'),
      edge(ids.renderImage, 'next', ids.sleep, 'prev', 'appNodeEdge'),
      edge(ids.seconds, 'fieldOutput', ids.sleep, 'fieldInput/duration', 'codeNodeEdge'),
      edge(ids.order, 'fieldOutput', ids.album, 'fieldInput/order', 'codeNodeEdge'),
      ...PHOTO_ALBUM_SHAPES.map((shape) =>
        edge(ids[shape.value], 'fieldOutput', ids.album, `fieldInput/${shape.value}`, 'codeNodeEdge')
      ),
      edge(ids.fit, 'fieldOutput', ids.renderImage, 'fieldInput/placement', 'codeNodeEdge'),
    ],
    apps: {
      [PHOTO_ALBUM_APP_KEY]: buildSceneApp(
        PHOTO_ALBUM_APP_KEY,
        embeddedRepoAppConfigs[PHOTO_ALBUM_APP_ORIGIN],
        sources,
        {
          origin: PHOTO_ALBUM_APP_ORIGIN,
        }
      ),
    },
  } as FrameScene
}
