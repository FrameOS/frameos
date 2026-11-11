// A line diff for showing what a scene update changes (the deploy drawer's
// "Scene updates"): Myers' shortest edit script, grouped into hunks with a
// few lines of context, the way `diff -u` prints them. Pure, no DOM.

export type DiffLine =
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'remove'; text: string; oldLine: number }

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

// Past this many edits the shortest script is not worth its memory (the
// trace grows with the square of it): the middle is shown as replaced.
const MAX_EDITS = 2000

/** `text` as lines, without the empty one a trailing newline leaves. */
export function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

type Op = 'equal' | 'add' | 'remove'

// The edit script between a and b (no common prefix or suffix left to trim).
function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) {
    return []
  }
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d]: the slice of v (k = -d-1 .. d+1) as it stood before step d.
  const trace: Int32Array[] = []
  let found = -1
  const at = (k: number): number => v[offset + k] ?? 0
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) {
      break
    }
  }
  if (found < 0) {
    return [...a.map((): Op => 'remove'), ...b.map((): Op => 'add')]
  }
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const slice = trace[d]
    const before = (k: number): number => slice?.[k + d + 1] ?? 0
    const k = x - y
    const prevK = k === -d || (k !== d && before(k - 1) < before(k + 1)) ? k + 1 : k - 1
    const prevX = before(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('equal')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('add')
      y--
    } else {
      ops.push('remove')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('equal')
    x--
    y--
  }
  return ops.reverse()
}

/** Every line of `before` and `after`, each marked kept, added or removed. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++
  }
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const ops: Op[] = [
    ...Array<Op>(start).fill('equal'),
    ...myers(before.slice(start, endBefore), after.slice(start, endAfter)),
    ...Array<Op>(before.length - endBefore).fill('equal'),
  ]
  const lines: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  for (const op of ops) {
    if (op === 'equal') {
      lines.push({ kind: 'context', text: before[oldIndex] ?? '', oldLine: oldIndex + 1, newLine: newIndex + 1 })
      oldIndex++
      newIndex++
    } else if (op === 'remove') {
      lines.push({ kind: 'remove', text: before[oldIndex] ?? '', oldLine: oldIndex + 1 })
      oldIndex++
    } else {
      lines.push({ kind: 'add', text: after[newIndex] ?? '', newLine: newIndex + 1 })
      newIndex++
    }
  }
  return lines
}

/** The changed lines of a diff with `context` kept lines around each run; empty when nothing changed. */
export function diffHunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((line) => line.kind !== 'context')
  const keep = lines.map((_, index) => {
    for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at++) {
      if (changed[at]) {
        return true
      }
    }
    return false
  })
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 1
  let newLine = 1
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (!current) {
        current = { oldStart: oldLine, newStart: newLine, lines: [] }
        hunks.push(current)
      }
      current.lines.push(line)
    } else {
      current = null
    }
    if (line.kind !== 'add') {
      oldLine++
    }
    if (line.kind !== 'remove') {
      newLine++
    }
  })
  return hunks
}
