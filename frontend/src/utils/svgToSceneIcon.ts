// An uploaded SVG file turned into a scene icon (utils/sceneIcon.ts): every
// filled shape in it as ONE path, mapped from its viewBox into the 24 box,
// drawn with the nonzero rule. Pure (no DOM), so it runs in the browser and
// in node tests alike. What cannot become one filled path (lines drawn with
// strokes, text, pictures, <use>) is refused with a plain sentence.

import {
  PATH_COMMAND_ARGS,
  SCENE_ICON_MAX_LENGTH,
  SCENE_ICON_SIZE,
  parsePathData,
  sceneIconPath,
  type PathDataCommand,
} from './sceneIcon'

export type SvgToSceneIconResult = { ok: true; icon: string } | { ok: false; error: string }

const NOT_SVG = 'This is not an SVG file, or not one that can be read.'
const TOO_BIG = 'This file is too big for an icon.'
const NO_SIZE = 'This SVG has no viewBox, width or height, so its size is unknown.'
const BAD_VIEWBOX = 'The viewBox of this SVG cannot be read.'
const PERCENT = 'This SVG gives a size in percent, which an icon cannot use. Save it with a viewBox and plain numbers.'
const BAD_PATH = 'One of the paths in this SVG cannot be read.'
const BAD_TRANSFORM = 'This SVG has a transform that cannot be read.'
const BAD_NUMBER = 'This SVG has numbers that cannot be read.'
const STROKES_ONLY =
  'This SVG draws lines (strokes), and an icon is one filled shape. Try the filled or solid version of the icon.'
const STROKES_MIXED =
  'Part of this SVG is drawn with lines (strokes), and an icon is one filled shape. Try the filled or solid version of the icon.'
const NOTHING = 'This SVG has no filled shape to make an icon of.'
const FAILED = 'This SVG could not be turned into an icon.'
const TEXT = 'This SVG has text in it. Turn the text into paths (outlines) first.'
const REFUSED_ELEMENTS = new Map<string, string>([
  ['text', TEXT],
  ['textPath', TEXT],
  ['tspan', TEXT],
  ['image', 'This SVG holds a picture (an <image>), and an icon is one filled shape.'],
  ['use', 'This SVG reuses its shapes with <use>. Save it with every shape written out and try again.'],
  ['foreignObject', 'This SVG holds HTML (a <foreignObject>), which an icon cannot.'],
  ['svg', 'This SVG has another <svg> inside it. Flatten it into one first.'],
])
const MAX_FILE_CHARS = 2_000_000

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

// ------------------------------------------------------------------- XML

interface XmlElement {
  tag: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

const ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text
  }
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][\w.-]*);/g, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    // An entity a DOCTYPE defines (Illustrator's namespaces) is left as it is.
    return ENTITIES.get(name) ?? whole
  })
}

const TAG_NAME = /[^\s/>=]+/y
const ATTRIBUTE = /\s+([^\s/>=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
const TAG_END = /\s*(\/?)>/y

/** The root element of `source`, or null for anything that is not well-formed XML. */
function parseXml(source: string): XmlElement | null {
  const text = source.replace(/^﻿/, '')
  const stack: XmlElement[] = []
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) {
      break
    }
    const parent = stack[stack.length - 1]
    if (open > pos && parent) {
      parent.text += decodeEntities(text.slice(pos, open))
    }
    pos = open
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4)
      if (end < 0) {
        return null
      }
      pos = end + 3
    } else if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9)
      if (end < 0) {
        return null
      }
      if (parent) {
        parent.text += text.slice(pos + 9, end)
      }
      pos = end + 3
    } else if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2)
      if (end < 0) {
        return null
      }
      pos = end + 2
    } else if (text.startsWith('<!', pos)) {
      // A DOCTYPE, its internal subset in brackets.
      let depth = 0
      let i = pos + 2
      for (; i < text.length; i++) {
        const char = text[i]
        if (char === '[') {
          depth++
        } else if (char === ']') {
          depth--
        } else if (char === '>' && depth <= 0) {
          break
        }
      }
      if (i >= text.length) {
        return null
      }
      pos = i + 1
    } else if (text[pos + 1] === '/') {
      const end = text.indexOf('>', pos)
      if (end < 0) {
        return null
      }
      const element = stack.pop()
      if (!element || element.tag !== text.slice(pos + 2, end).trim()) {
        return null
      }
      if (stack.length === 0) {
        return element
      }
      pos = end + 1
    } else {
      TAG_NAME.lastIndex = pos + 1
      const name = TAG_NAME.exec(text)
      if (!name) {
        return null
      }
      const element: XmlElement = { tag: name[0], attrs: {}, children: [], text: '' }
      let i = TAG_NAME.lastIndex
      let selfClosing = false
      for (;;) {
        TAG_END.lastIndex = i
        const end = TAG_END.exec(text)
        if (end) {
          selfClosing = end[1] === '/'
          i = TAG_END.lastIndex
          break
        }
        ATTRIBUTE.lastIndex = i
        const attribute = ATTRIBUTE.exec(text)
        if (!attribute) {
          return null
        }
        element.attrs[attribute[1] ?? ''] = decodeEntities(attribute[2] ?? attribute[3] ?? '')
        i = ATTRIBUTE.lastIndex
      }
      parent?.children.push(element)
      if (!selfClosing) {
        stack.push(element)
      } else if (stack.length === 0) {
        return element
      }
      pos = i
    }
  }
  return null
}

/** An element's name without the `svg:` prefix; null for another namespace's (Inkscape's, Sodipodi's). */
function localName(tag: string): string | null {
  const colon = tag.indexOf(':')
  if (colon < 0) {
    return tag
  }
  return tag.slice(0, colon) === 'svg' ? tag.slice(colon + 1) : null
}

// ----------------------------------------------------------------- styles

const PROPERTIES = [
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'opacity',
  'display',
  'visibility',
]

interface CssRule {
  tag: string | null
  id: string | null
  classes: string[]
  specificity: number
  order: number
  declarations: Record<string, string>
}

function parseDeclarations(text: string): Record<string, string> {
  const declarations: Record<string, string> = {}
  for (const part of text.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) {
      continue
    }
    const name = part.slice(0, colon).trim().toLowerCase()
    const value = part
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
    if (name && value) {
      declarations[name] = value
    }
  }
  return declarations
}

const SIMPLE_SELECTOR = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/

/** The rules of the SVG's <style> elements a shape can match: tag, .class and #id selectors. */
function parseStylesheet(css: string): CssRule[] {
  const rules: CssRule[] = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = parseDeclarations(match[2] ?? '')
    for (const selector of (match[1] ?? '').split(',')) {
      const parts = SIMPLE_SELECTOR.exec(selector.trim())
      if (!parts || !selector.trim()) {
        continue // a combinator or an at-rule: not an icon's
      }
      const tag = parts[1] && parts[1] !== '*' ? parts[1] : null
      const classes = [...(parts[2] ?? '').matchAll(/\.([\w-]+)/g)].map((found) => found[1] ?? '')
      const id = /#([\w-]+)/.exec(parts[2] ?? '')?.[1] ?? null
      rules.push({
        tag,
        id,
        classes,
        specificity: (id ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0),
        order: rules.length,
        declarations,
      })
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
}

function collectStyleText(element: XmlElement): string {
  let text = localName(element.tag) === 'style' ? element.text : ''
  for (const child of element.children) {
    text += '\n' + collectStyleText(child)
  }
  return text
}

/** What an element says of its look: attributes, then the stylesheet, then its style="". */
function declaredStyle(element: XmlElement, name: string, rules: CssRule[]): Record<string, string> {
  const declared: Record<string, string> = {}
  for (const property of PROPERTIES) {
    const value = element.attrs[property]
    if (value !== undefined && value.trim()) {
      declared[property] = value.trim()
    }
  }
  const classes = (element.attrs.class ?? '').split(/\s+/).filter(Boolean)
  for (const rule of rules) {
    if (
      (rule.tag === null || rule.tag === name) &&
      (rule.id === null || rule.id === element.attrs.id) &&
      rule.classes.every((className) => classes.includes(className))
    ) {
      Object.assign(declared, rule.declarations)
    }
  }
  if (element.attrs.style) {
    Object.assign(declared, parseDeclarations(element.attrs.style))
  }
  return declared
}

interface Paint {
  fill: string
  fillRule: string
  fillOpacity: string
  stroke: string
  strokeWidth: string
  strokeOpacity: string
  visibility: string
}

const INITIAL_PAINT: Paint = {
  fill: 'black',
  fillRule: 'nonzero',
  fillOpacity: '1',
  stroke: 'none',
  strokeWidth: '1',
  strokeOpacity: '1',
  visibility: 'visible',
}

function inheritPaint(parent: Paint, declared: Record<string, string>): Paint {
  const pick = (property: string, inherited: string): string => {
    const value = declared[property]
    return value === undefined || value === 'inherit' ? inherited : value
  }
  return {
    fill: pick('fill', parent.fill),
    fillRule: pick('fill-rule', parent.fillRule),
    fillOpacity: pick('fill-opacity', parent.fillOpacity),
    stroke: pick('stroke', parent.stroke),
    strokeWidth: pick('stroke-width', parent.strokeWidth),
    strokeOpacity: pick('stroke-opacity', parent.strokeOpacity),
    visibility: pick('visibility', parent.visibility),
  }
}

function amount(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const number = parseFloat(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return value.trim().endsWith('%') ? number / 100 : number
}

function paints(color: string): boolean {
  const value = color.trim().toLowerCase()
  return value !== 'none' && value !== 'transparent'
}

function isFilled(paint: Paint): boolean {
  return paint.visibility === 'visible' && paints(paint.fill) && amount(paint.fillOpacity, 1) > 0
}

function isStroked(paint: Paint): boolean {
  return (
    paint.visibility === 'visible' &&
    paints(paint.stroke) &&
    amount(paint.strokeWidth, 1) > 0 &&
    amount(paint.strokeOpacity, 1) > 0
  )
}

// ---------------------------------------------------------------- numbers

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?$/
const UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 }
const NUMBERS = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

/** A length in user units, null when absent or unreadable ("auto" included). */
function length(value: string | undefined): number | null {
  if (value === undefined) {
    return null
  }
  const match = LENGTH.exec(value.trim())
  if (!match) {
    return null
  }
  if (match[2] === '%') {
    refuse(PERCENT)
  }
  const number = Number(match[1]) * (UNITS[match[2] ?? 'px'] ?? 1)
  return Number.isFinite(number) ? number : null
}

function numberList(value: string): number[] {
  return [...value.matchAll(NUMBERS)].map((match) => Number(match[0]))
}

// --------------------------------------------------------------- matrices

type Point = { x: number; y: number }

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `m` after `n`: n applies first. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

const TRANSFORM = /[\s,]*([a-zA-Z]+)\s*\(([^)]*)\)/y

function parseTransform(text: string): Matrix {
  let matrix = IDENTITY
  let pos = 0
  const source = text.trim()
  while (pos < source.length) {
    TRANSFORM.lastIndex = pos
    const match = TRANSFORM.exec(source)
    if (!match) {
      refuse(BAD_TRANSFORM)
    }
    pos = TRANSFORM.lastIndex
    const inner = (match[2] ?? '').trim()
    const args = inner ? inner.split(/[\s,]+/).map(Number) : []
    if (args.some((value) => !Number.isFinite(value))) {
      refuse(BAD_TRANSFORM)
    }
    const [a = 0, b, c = 0, d = 0, e = 0, f = 0] = args
    const radians = (degrees: number): number => (degrees * Math.PI) / 180
    let step: Matrix
    switch (`${match[1]}/${args.length}`) {
      case 'matrix/6':
        step = [a, b ?? 0, c, d, e, f]
        break
      case 'translate/1':
      case 'translate/2':
        step = [1, 0, 0, 1, a, b ?? 0]
        break
      case 'scale/1':
      case 'scale/2':
        step = [a, 0, 0, b ?? a, 0, 0]
        break
      case 'rotate/1':
      case 'rotate/3': {
        const [cos, sin] = [Math.cos(radians(a)), Math.sin(radians(a))]
        const [cx, cy] = [b ?? 0, c]
        step = multiply(multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy])
        break
      }
      case 'skewX/1':
        step = [1, 0, Math.tan(radians(a)), 1, 0, 0]
        break
      case 'skewY/1':
        step = [1, Math.tan(radians(a)), 0, 1, 0, 0]
        break
      default:
        refuse(BAD_TRANSFORM)
    }
    matrix = multiply(matrix, step)
  }
  return matrix
}

/** The root's viewBox (or width and height) mapped into the 24 box, as preserveAspectRatio says. */
function viewportMatrix(root: XmlElement): Matrix {
  const size = SCENE_ICON_SIZE
  let [minX, minY, width, height] = [0, 0, 0, 0]
  const viewBox = root.attrs.viewBox ?? root.attrs.viewbox
  if (viewBox !== undefined) {
    const values = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    ;[minX = 0, minY = 0, width = 0, height = 0] = values
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || width <= 0 || height <= 0) {
      refuse(BAD_VIEWBOX)
    }
  } else {
    width = length(root.attrs.width) ?? 0
    height = length(root.attrs.height) ?? 0
    if (!(width > 0 && height > 0)) {
      refuse(NO_SIZE)
    }
  }
  const [align, meetOrSlice] = (root.attrs.preserveAspectRatio ?? '').trim().split(/\s+/)
  if (align === 'none') {
    return [size / width, 0, 0, size / height, (-minX * size) / width, (-minY * size) / height]
  }
  const scale = meetOrSlice === 'slice' ? Math.max(size / width, size / height) : Math.min(size / width, size / height)
  const share = (axis: 'x' | 'y'): number => {
    const min = axis === 'x' ? 'xMin' : 'YMin'
    const max = axis === 'x' ? 'xMax' : 'YMax'
    return align?.includes(min) ? 0 : align?.includes(max) ? 1 : 0.5
  }
  return [
    scale,
    0,
    0,
    scale,
    (size - width * scale) * share('x') - minX * scale,
    (size - height * scale) * share('y') - minY * scale,
  ]
}

// --------------------------------------------------------------- geometry

type Segment =
  | { kind: 'L'; x: number; y: number }
  | { kind: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { kind: 'Q'; x1: number; y1: number; x: number; y: number }
  | { kind: 'A'; rx: number; ry: number; angle: number; large: boolean; sweep: boolean; x: number; y: number }

/** One subpath in absolute coordinates, from (x, y). */
interface Subpath {
  x: number
  y: number
  segments: Segment[]
  closed: boolean
}

/** Path data as subpaths of lines, curves and arcs: H/V as lines, S/T with their control points reflected. */
function subpathsOf(commands: PathDataCommand[]): Subpath[] {
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let [x, y, startX, startY] = [0, 0, 0, 0]
  let previous = ''
  let control = { x: 0, y: 0 } // the last C/S or Q/T control point, for a reflection
  const add = (segment: Segment): void => {
    if (!current || current.closed) {
      // After a Z, the next subpath starts where that one did.
      current = { x, y, segments: [], closed: false }
      subpaths.push(current)
    }
    current.segments.push(segment)
    x = segment.x
    y = segment.y
  }
  for (const { command, args } of commands) {
    const upper = command.toUpperCase()
    const relative = command !== upper
    if (upper === 'Z') {
      if (current) {
        current.closed = true
      }
      x = startX
      y = startY
      previous = 'Z'
      continue
    }
    const count = PATH_COMMAND_ARGS[upper]
    if (!count) {
      continue
    }
    for (let i = 0; i < args.length; i += count) {
      const ox = relative ? x : 0
      const oy = relative ? y : 0
      // The k-th number of this group, and as an x or a y (relative ones from the current point).
      const n = (k: number): number => args[i + k] ?? 0
      const px = (k: number): number => n(k) + ox
      const py = (k: number): number => n(k) + oy
      const kind = upper === 'M' && i > 0 ? 'L' : upper
      switch (kind) {
        case 'M':
          x = startX = px(0)
          y = startY = py(1)
          current = { x, y, segments: [], closed: false }
          subpaths.push(current)
          break
        case 'L':
          add({ kind: 'L', x: px(0), y: py(1) })
          break
        case 'H':
          add({ kind: 'L', x: px(0), y })
          break
        case 'V':
          add({ kind: 'L', x, y: py(0) })
          break
        case 'C':
        case 'S': {
          const reflect = previous === 'C' || previous === 'S'
          const first =
            kind === 'C' ? { x: px(0), y: py(1) } : reflect ? { x: 2 * x - control.x, y: 2 * y - control.y } : { x, y }
          const at = kind === 'C' ? 2 : 0
          control = { x: px(at), y: py(at + 1) }
          add({ kind: 'C', x1: first.x, y1: first.y, x2: control.x, y2: control.y, x: px(at + 2), y: py(at + 3) })
          break
        }
        case 'Q':
        case 'T': {
          const reflect = previous === 'Q' || previous === 'T'
          control =
            kind === 'Q' ? { x: px(0), y: py(1) } : reflect ? { x: 2 * x - control.x, y: 2 * y - control.y } : { x, y }
          const at = kind === 'Q' ? 2 : 0
          add({ kind: 'Q', x1: control.x, y1: control.y, x: px(at), y: py(at + 1) })
          break
        }
        case 'A': {
          const [endX, endY] = [px(5), py(6)]
          if (endX === x && endY === y) {
            break // an arc that goes nowhere is left out
          }
          if (n(0) === 0 || n(1) === 0) {
            add({ kind: 'L', x: endX, y: endY })
          } else {
            add({
              kind: 'A',
              rx: Math.abs(n(0)),
              ry: Math.abs(n(1)),
              angle: n(2),
              large: n(3) !== 0,
              sweep: n(4) !== 0,
              x: endX,
              y: endY,
            })
          }
          break
        }
      }
      previous = kind
    }
  }
  return subpaths.filter((subpath) => subpath.segments.length > 0)
}

interface ArcCenter {
  cx: number
  cy: number
  rx: number
  ry: number
  cos: number
  sin: number
  start: number
  sweep: number
}

/** An arc from (x1, y1) by its center (SVG implementation notes F.6.5), null when it is a line. */
function arcCenter(x1: number, y1: number, arc: Extract<Segment, { kind: 'A' }>): ArcCenter | null {
  let rx = Math.abs(arc.rx)
  let ry = Math.abs(arc.ry)
  if (rx === 0 || ry === 0 || (x1 === arc.x && y1 === arc.y)) {
    return null
  }
  const phi = (arc.angle * Math.PI) / 180
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)]
  const dx = (x1 - arc.x) / 2
  const dy = (y1 - arc.y) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coefficient = denominator === 0 ? 0 : Math.sqrt(Math.max(0, numerator / denominator))
  if (arc.large === arc.sweep) {
    coefficient = -coefficient
  }
  const cxp = (coefficient * rx * y1p) / ry
  const cyp = (-coefficient * ry * x1p) / rx
  const angle = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let sweep = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!arc.sweep && sweep > 0) {
    sweep -= 2 * Math.PI
  } else if (arc.sweep && sweep < 0) {
    sweep += 2 * Math.PI
  }
  return {
    cx: cos * cxp - sin * cyp + (x1 + arc.x) / 2,
    cy: sin * cxp + cos * cyp + (y1 + arc.y) / 2,
    rx,
    ry,
    cos,
    sin,
    start,
    sweep,
  }
}

function arcPoint(c: ArcCenter, t: number): Point {
  return {
    x: c.cx + c.rx * c.cos * Math.cos(t) - c.ry * c.sin * Math.sin(t),
    y: c.cy + c.rx * c.sin * Math.cos(t) + c.ry * c.cos * Math.sin(t),
  }
}

/** An arc as cubic curves, a quarter turn at most each (F.6.6 for what a skew does to an ellipse). */
function arcToCubics(x1: number, y1: number, arc: Extract<Segment, { kind: 'A' }>): Segment[] {
  const c = arcCenter(x1, y1, arc)
  if (!c) {
    return [{ kind: 'L', x: arc.x, y: arc.y }]
  }
  const pieces = Math.max(1, Math.ceil(Math.abs(c.sweep) / (Math.PI / 2) - 1e-9))
  const step = c.sweep / pieces
  const k = (4 / 3) * Math.tan(step / 4)
  const tangent = (t: number): Point => ({
    x: -c.rx * c.cos * Math.sin(t) - c.ry * c.sin * Math.cos(t),
    y: -c.rx * c.sin * Math.sin(t) + c.ry * c.cos * Math.cos(t),
  })
  const segments: Segment[] = []
  for (let i = 0; i < pieces; i++) {
    const t0 = c.start + i * step
    const t1 = t0 + step
    const from = arcPoint(c, t0)
    const to = i === pieces - 1 ? { x: arc.x, y: arc.y } : arcPoint(c, t1)
    const [d0, d1] = [tangent(t0), tangent(t1)]
    segments.push({
      kind: 'C',
      x1: from.x + k * d0.x,
      y1: from.y + k * d0.y,
      x2: to.x - k * d1.x,
      y2: to.y - k * d1.y,
      x: to.x,
      y: to.y,
    })
  }
  return segments
}

function transformSubpath(subpath: Subpath, m: Matrix): Subpath {
  const determinant = m[0] * m[3] - m[1] * m[2]
  const tolerance = 1e-9 * Math.max(1, Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]))
  // A similarity (turn, mirror, even scale) keeps an ellipse an ellipse; a skew or a stretch does not.
  const similar =
    determinant !== 0 &&
    ((Math.abs(m[0] - m[3]) < tolerance && Math.abs(m[1] + m[2]) < tolerance) ||
      (Math.abs(m[0] + m[3]) < tolerance && Math.abs(m[1] - m[2]) < tolerance))
  const scale = Math.sqrt(Math.abs(determinant))
  const start = apply(m, subpath.x, subpath.y)
  const segments: Segment[] = []
  let [x, y] = [subpath.x, subpath.y]
  const transformed = (segment: Segment): Segment => {
    const end = apply(m, segment.x, segment.y)
    if (segment.kind === 'C') {
      const [p1, p2] = [apply(m, segment.x1, segment.y1), apply(m, segment.x2, segment.y2)]
      return { kind: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: end.x, y: end.y }
    }
    if (segment.kind === 'Q') {
      const p1 = apply(m, segment.x1, segment.y1)
      return { kind: 'Q', x1: p1.x, y1: p1.y, x: end.x, y: end.y }
    }
    return { kind: 'L', x: end.x, y: end.y }
  }
  for (const segment of subpath.segments) {
    if (segment.kind !== 'A') {
      segments.push(transformed(segment))
    } else if (similar) {
      const phi = (segment.angle * Math.PI) / 180
      const direction = {
        x: m[0] * Math.cos(phi) + m[2] * Math.sin(phi),
        y: m[1] * Math.cos(phi) + m[3] * Math.sin(phi),
      }
      const end = apply(m, segment.x, segment.y)
      segments.push({
        kind: 'A',
        rx: segment.rx * scale,
        ry: segment.ry * scale,
        angle: (Math.atan2(direction.y, direction.x) * 180) / Math.PI,
        large: segment.large,
        sweep: determinant < 0 ? !segment.sweep : segment.sweep,
        x: end.x,
        y: end.y,
      })
    } else {
      segments.push(...arcToCubics(x, y, segment).map(transformed))
    }
    x = segment.x
    y = segment.y
  }
  return { x: start.x, y: start.y, segments, closed: subpath.closed }
}

/** The subpath as a polygon, its curves and arcs in short straight steps. */
function flatten(subpath: Subpath): Point[] {
  const points = [{ x: subpath.x, y: subpath.y }]
  let [x, y] = [subpath.x, subpath.y]
  const steps = 16
  for (const segment of subpath.segments) {
    if (segment.kind === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const u = 1 - t
        points.push({
          x: u * u * u * x + 3 * u * u * t * segment.x1 + 3 * u * t * t * segment.x2 + t * t * t * segment.x,
          y: u * u * u * y + 3 * u * u * t * segment.y1 + 3 * u * t * t * segment.y2 + t * t * t * segment.y,
        })
      }
    } else if (segment.kind === 'Q') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const u = 1 - t
        points.push({
          x: u * u * x + 2 * u * t * segment.x1 + t * t * segment.x,
          y: u * u * y + 2 * u * t * segment.y1 + t * t * segment.y,
        })
      }
    } else if (segment.kind === 'A') {
      const c = arcCenter(x, y, segment)
      if (c) {
        const count = Math.max(8, Math.ceil(Math.abs(c.sweep) / (Math.PI / 16)))
        for (let i = 1; i < count; i++) {
          points.push(arcPoint(c, c.start + (c.sweep * i) / count))
        }
      }
      points.push({ x: segment.x, y: segment.y })
    } else {
      points.push({ x: segment.x, y: segment.y })
    }
    x = segment.x
    y = segment.y
  }
  return points
}

/** Each edge of a closed polygon, the last back to the first. */
function edges(points: Point[]): [Point, Point][] {
  const last = points[points.length - 1]
  if (!last) {
    return []
  }
  let from = last
  return points.map((to) => {
    const edge: [Point, Point] = [from, to]
    from = to
    return edge
  })
}

function signedArea(points: Point[]): number {
  return edges(points).reduce((sum, [a, b]) => sum + (a.x * b.y - b.x * a.y) / 2, 0)
}

/** The nonzero winding of a closed polygon around (x, y). */
function windingAround(points: Point[], x: number, y: number): number {
  let winding = 0
  for (const [a, b] of edges(points)) {
    const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y)
    if (a.y <= y) {
      if (b.y > y && side > 0) {
        winding++
      }
    } else if (b.y <= y && side < 0) {
      winding--
    }
  }
  return winding
}

function reversed(subpath: Subpath): Subpath {
  // Each segment with where it starts, then walked back from the far end.
  let from: Point = { x: subpath.x, y: subpath.y }
  const pieces = subpath.segments.map((segment) => {
    const piece = { segment, to: from }
    from = { x: segment.x, y: segment.y }
    return piece
  })
  const segments = pieces.reverse().map(({ segment, to }): Segment => {
    if (segment.kind === 'C') {
      return { kind: 'C', x1: segment.x2, y1: segment.y2, x2: segment.x1, y2: segment.y1, x: to.x, y: to.y }
    }
    if (segment.kind === 'Q') {
      return { kind: 'Q', x1: segment.x1, y1: segment.y1, x: to.x, y: to.y }
    }
    if (segment.kind === 'A') {
      return { ...segment, sweep: !segment.sweep, x: to.x, y: to.y }
    }
    return { kind: 'L', x: to.x, y: to.y }
  })
  return { x: from.x, y: from.y, segments, closed: subpath.closed }
}

/**
 * One shape's subpaths turned so that every shape's outside runs the way the
 * first one's does: drawn as one nonzero path, overlapping shapes then add up
 * instead of cutting holes in each other. An evenodd shape's subpaths go by
 * how deep each sits inside the others (inside out it alternates), which is
 * exact for outlines that do not cross; a nonzero shape is turned whole, so
 * its own holes stay holes.
 */
function oriented(subpaths: Subpath[], evenOdd: boolean, context: { direction: number }): Subpath[] {
  const measured = subpaths.map((subpath) => {
    const polygon = flatten(subpath)
    return { subpath, polygon, area: signedArea(polygon) }
  })
  const largest = measured.reduce((best, item) => (Math.abs(item.area) > Math.abs(best) ? item.area : best), 0)
  if (context.direction === 0) {
    context.direction = Math.sign(largest) || 1
  }
  if (!evenOdd) {
    return Math.sign(largest) === -context.direction ? subpaths.map(reversed) : subpaths
  }
  return measured.map(({ subpath, polygon, area }) => {
    // A few of its points, so one that touches another outline does not decide alone.
    const every = Math.max(1, Math.floor(polygon.length / 7))
    const samples = polygon.filter((_, n) => n % every === 0).slice(0, 7)
    let depth = 0
    for (const other of measured) {
      if (other.subpath === subpath || Math.abs(other.area) <= Math.abs(area)) {
        continue
      }
      const inside = samples.filter((point) => windingAround(other.polygon, point.x, point.y) !== 0).length
      if (inside * 2 > samples.length) {
        depth++
      }
    }
    const wanted = depth % 2 === 0 ? context.direction : -context.direction
    return area * wanted < 0 ? reversed(subpath) : subpath
  })
}

// ----------------------------------------------------------------- shapes

/** An element's outline in its own coordinates; 'line' for one with no inside; null for no shape. */
function shapeOf(name: string, element: XmlElement): Subpath[] | 'line' | null {
  const attr = (key: string): number => length(element.attrs[key]) ?? 0
  switch (name) {
    case 'path': {
      const d = element.attrs.d ?? ''
      if (!d.trim()) {
        return []
      }
      const commands = parsePathData(d)
      if (!commands) {
        refuse(BAD_PATH)
      }
      return subpathsOf(commands)
    }
    case 'rect': {
      const [x, y, width, height] = [attr('x'), attr('y'), attr('width'), attr('height')]
      if (width <= 0 || height <= 0) {
        return []
      }
      // One radius given stands for both, each then held to half its side.
      const givenX = length(element.attrs.rx)
      const givenY = length(element.attrs.ry)
      const rx = Math.min(Math.abs(givenX ?? givenY ?? 0), width / 2)
      const ry = Math.min(Math.abs(givenY ?? givenX ?? 0), height / 2)
      if (rx === 0 || ry === 0) {
        const corners: Segment[] = [
          { kind: 'L', x: x + width, y },
          { kind: 'L', x: x + width, y: y + height },
          { kind: 'L', x, y: y + height },
        ]
        return [{ x, y, segments: corners, closed: true }]
      }
      const corner = (cx: number, cy: number): Segment => ({
        kind: 'A',
        rx,
        ry,
        angle: 0,
        large: false,
        sweep: true,
        x: cx,
        y: cy,
      })
      const segments: Segment[] = [
        { kind: 'L', x: x + width - rx, y },
        corner(x + width, y + ry),
        { kind: 'L', x: x + width, y: y + height - ry },
        corner(x + width - rx, y + height),
        { kind: 'L', x: x + rx, y: y + height },
        corner(x, y + height - ry),
        { kind: 'L', x, y: y + ry },
        corner(x + rx, y),
      ]
      return [{ x: x + rx, y, segments, closed: true }]
    }
    case 'circle':
    case 'ellipse': {
      const [cx, cy] = [attr('cx'), attr('cy')]
      const r = name === 'circle' ? attr('r') : null
      const rx = r ?? length(element.attrs.rx) ?? length(element.attrs.ry) ?? 0
      const ry = r ?? length(element.attrs.ry) ?? rx
      if (rx <= 0 || ry <= 0) {
        return []
      }
      const half = (x: number): Segment => ({ kind: 'A', rx, ry, angle: 0, large: false, sweep: true, x, y: cy })
      return [{ x: cx + rx, y: cy, segments: [half(cx - rx), half(cx + rx)], closed: true }]
    }
    case 'polygon':
    case 'polyline': {
      // Pairs of numbers; an odd one at the end is dropped, as SVG draws up to it.
      const values = numberList(element.attrs.points ?? '')
      const points = values.flatMap((x, i) =>
        i % 2 === 0 && i + 1 < values.length ? [{ x, y: values[i + 1] ?? 0 }] : []
      )
      const [first, ...rest] = points
      if (!first || rest.length === 0) {
        return []
      }
      const segments = rest.map((point): Segment => ({ kind: 'L', x: point.x, y: point.y }))
      return [{ x: first.x, y: first.y, segments, closed: name === 'polygon' }]
    }
    case 'line':
      return 'line'
    default:
      return null
  }
}

// ------------------------------------------------------------------ output

function formatNumber(value: number, decimals: number): string {
  let text = value.toFixed(decimals)
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  if (text === '-0') {
    return '0'
  }
  if (text.startsWith('0.')) {
    return text.slice(1)
  }
  if (text.startsWith('-0.')) {
    return '-' + text.slice(2)
  }
  return text
}

/** The subpaths as path data: absolute, rounded to `decimals`, the short forms where they say the same. */
function serialize(subpaths: Subpath[], decimals: number): string {
  const round = (value: number): number => Number(formatNumber(value, decimals))
  let out = ''
  let last = ''
  const emit = (letter: string, values: (number | string)[]): void => {
    if (letter !== last || letter === 'M') {
      out += letter
    }
    let afterLetter = letter !== last || letter === 'M'
    for (const value of values) {
      const text = typeof value === 'string' ? value : formatNumber(value, decimals)
      if (!afterLetter && !text.startsWith('-')) {
        out += ' '
      }
      out += text
      afterLetter = false
    }
    last = letter
  }
  for (const subpath of subpaths) {
    const [startX, startY] = [round(subpath.x), round(subpath.y)]
    let [x, y] = [startX, startY]
    const body: [string, (number | string)[]][] = []
    const line = (toX: number, toY: number, closing: boolean): void => {
      if ((toX === x && toY === y) || (closing && toX === startX && toY === startY)) {
        return
      }
      body.push(toY === y ? ['H', [toX]] : toX === x ? ['V', [toY]] : ['L', [toX, toY]])
      x = toX
      y = toY
    }
    subpath.segments.forEach((segment, i) => {
      const closing = subpath.closed && i === subpath.segments.length - 1
      const [toX, toY] = [round(segment.x), round(segment.y)]
      if (segment.kind === 'L') {
        line(toX, toY, closing)
      } else if (segment.kind === 'C') {
        const values = [segment.x1, segment.y1, segment.x2, segment.y2].map(round)
        if (values.every((value, n) => value === (n % 2 === 0 ? x : y)) && toX === x && toY === y) {
          return
        }
        body.push(['C', [...values, toX, toY]])
        x = toX
        y = toY
      } else if (segment.kind === 'Q') {
        const values = [segment.x1, segment.y1].map(round)
        if (values[0] === x && values[1] === y && toX === x && toY === y) {
          return
        }
        body.push(['Q', [...values, toX, toY]])
        x = toX
        y = toY
      } else {
        const [rx, ry] = [round(segment.rx), round(segment.ry)]
        if (toX === x && toY === y) {
          return
        }
        if (rx === 0 || ry === 0) {
          line(toX, toY, false)
          return
        }
        const angle = rx === ry ? 0 : round((((segment.angle % 360) + 360) % 360) % 180)
        body.push(['A', [rx, ry, angle, segment.large ? '1' : '0', segment.sweep ? '1' : '0', toX, toY]])
        x = toX
        y = toY
      }
    })
    if (body.length === 0) {
      continue // it draws nothing
    }
    emit('M', [startX, startY])
    for (const [letter, values] of body) {
      emit(letter, values)
    }
    if (subpath.closed) {
      emit('Z', [])
    }
  }
  return out
}

// ------------------------------------------------------------------- walk

interface WalkContext {
  rules: CssRule[]
  shapes: Subpath[][]
  strokes: boolean
  direction: number
}

function walk(element: XmlElement, matrix: Matrix, paint: Paint, context: WalkContext): void {
  for (const child of element.children) {
    const name = localName(child.tag)
    if (name === null) {
      continue // an editor's own element (sodipodi:namedview)
    }
    const declared = declaredStyle(child, name, context.rules)
    if (declared.display === 'none' || amount(declared.opacity, 1) <= 0) {
      continue
    }
    const refused = REFUSED_ELEMENTS.get(name)
    if (refused) {
      refuse(refused)
    }
    const own = inheritPaint(paint, declared)
    const local = child.attrs.transform ? multiply(matrix, parseTransform(child.attrs.transform)) : matrix
    if (name === 'g' || name === 'a' || name === 'switch') {
      walk(child, local, own, context)
      continue
    }
    // defs, clipPath, mask, gradients, symbol, title and the like draw nothing here.
    const shape = shapeOf(name, child)
    if (shape === null) {
      continue
    }
    if (shape === 'line' || !isFilled(own)) {
      // Material icons carry an invisible M0 0h24v24H0z box: no fill, no stroke, nothing drawn.
      context.strokes ||= isStroked(own)
      continue
    }
    const subpaths = shape.map((subpath) => transformSubpath(subpath, local))
    if (subpaths.length > 0) {
      context.shapes.push(oriented(subpaths, own.fillRule.trim().toLowerCase() === 'evenodd', context))
    }
  }
}

/** `svgText` (an SVG file) as one icon path, or why it cannot be one. */
export function svgToSceneIcon(svgText: string): SvgToSceneIconResult {
  try {
    if (typeof svgText !== 'string' || !svgText.trim()) {
      refuse(NOT_SVG)
    }
    if (svgText.length > MAX_FILE_CHARS) {
      refuse(TOO_BIG)
    }
    const root = parseXml(svgText)
    if (!root || localName(root.tag) !== 'svg') {
      refuse(NOT_SVG)
    }
    const context: WalkContext = {
      rules: parseStylesheet(collectStyleText(root)),
      shapes: [],
      strokes: false,
      direction: 0,
    }
    const rootPaint = inheritPaint(INITIAL_PAINT, declaredStyle(root, 'svg', context.rules))
    walk(root, viewportMatrix(root), rootPaint, context)
    if (context.strokes) {
      refuse(context.shapes.length > 0 ? STROKES_MIXED : STROKES_ONLY)
    }
    const subpaths = context.shapes.flat()
    if (
      subpaths.some(
        (subpath) =>
          !Number.isFinite(subpath.x) ||
          !Number.isFinite(subpath.y) ||
          subpath.segments.some((segment) =>
            Object.values(segment).some((value) => typeof value === 'number' && !Number.isFinite(value))
          )
      )
    ) {
      refuse(BAD_NUMBER)
    }
    let shortest = 0
    // Finer first; coarser only where the finer one is too long to travel.
    for (const decimals of [2, 1, 0]) {
      const icon = serialize(subpaths, decimals)
      if (!icon) {
        refuse(NOTHING)
      }
      if (icon.length <= SCENE_ICON_MAX_LENGTH) {
        return sceneIconPath(icon) === icon ? { ok: true, icon } : { ok: false, error: FAILED }
      }
      shortest = icon.length
    }
    refuse(
      `This SVG makes a path of ${shortest} characters, and an icon can be ${SCENE_ICON_MAX_LENGTH} at most. Try a simpler icon.`
    )
  } catch (error) {
    return { ok: false, error: error instanceof Refusal ? error.message : FAILED }
  }
}

/** The nonzero winding number of an icon around (x, y), its curves flattened: 0 is outside. For tests and checks. */
export function sceneIconWindingNumber(icon: string, x: number, y: number): number {
  const commands = parsePathData(icon)
  if (!commands) {
    return 0
  }
  return subpathsOf(commands).reduce((winding, subpath) => winding + windingAround(flatten(subpath), x, y), 0)
}
