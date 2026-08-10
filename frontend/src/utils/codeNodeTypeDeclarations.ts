import type { CodeArg, FieldType } from '../types'

/**
 * TypeScript declarations for the JS code nodes in a diagram.
 *
 * Monaco's TypeScript service has exactly one global scope shared by every
 * model, so an "extra lib" per code node does not give each node its own view
 * of the world: when two nodes declare the same identifier, TypeScript keeps
 * the FIRST declaration in file order and ignores the rest. Code nodes chained
 * together almost always reuse the same argument name (an `imgTag` produced by
 * one node is consumed as `imgTag` by the next), so per-node libs meant the
 * type shown in a node's editor was whichever node happened to register first
 * — and re-registering a node's lib after an edit moves it to the *end* of that
 * order, i.e. a type change could never win.
 *
 * So the whole diagram shares one lib instead. The frameos globals are declared
 * once (they used to be duplicated into every node's lib, which is a pile of
 * duplicate-identifier errors as soon as a scene has two code nodes), and a
 * name claimed by several nodes is typed after the node currently being edited.
 */

const fieldTypeToTsType: Record<FieldType, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string',
  date: 'string',
  json: 'Record<string, any>',
  node: 'any',
  scene: 'string',
  image: 'string',
  font: 'string',
}

const frameosGlobals = `declare function now(): number;
declare function parseTs(format: string, text: string): number;
declare function format(ts: number, format: string): string;
declare function getState(key: string): any;
declare function getArg(key: string): any;
declare function getContext(key: string): any;
declare const state: Record<string, any>;
declare const args: Record<string, any>;
declare const context: {
  loopIndex?: number;
  loopKey?: string;
  event?: string;
  payload?: any;
  hasImage?: boolean;
};
`

/** Names the block above already owns; an arg may not redeclare them. */
const reservedNames = new Set([
  'now',
  'parseTs',
  'format',
  'getState',
  'getArg',
  'getContext',
  'state',
  'args',
  'context',
])

export interface CodeNodeArgsEntry {
  nodeId: string
  codeArgs: CodeArg[]
}

/** The single file every code node's declarations are published under. */
export const codeNodeTypesPath = 'inmemory://code-node/globals.d.ts'

export function isValidTsIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name)
}

/**
 * Build the shared declaration file. `activeNodeId` (the code node whose editor
 * has focus) is declared first, so its argument types are the ones TypeScript
 * resolves wherever two nodes claim the same name.
 */
export function buildCodeNodeDeclarations(
  entries: CodeNodeArgsEntry[],
  activeNodeId?: string | null
): string {
  const seenNodes = new Set<string>()
  const ordered: CodeNodeArgsEntry[] = []
  for (const entry of entries) {
    if (entry.nodeId === activeNodeId && !seenNodes.has(entry.nodeId)) {
      seenNodes.add(entry.nodeId)
      ordered.unshift(entry)
    } else if (!seenNodes.has(entry.nodeId)) {
      seenNodes.add(entry.nodeId)
      ordered.push(entry)
    }
  }

  const declared = new Set<string>()
  const lines: string[] = []
  for (const entry of ordered) {
    for (const arg of entry.codeArgs ?? []) {
      if (!arg?.name || !isValidTsIdentifier(arg.name) || reservedNames.has(arg.name) || declared.has(arg.name)) {
        continue
      }
      declared.add(arg.name)
      lines.push(`declare const ${arg.name}: ${fieldTypeToTsType[arg.type] ?? 'any'};`)
    }
  }

  return `${frameosGlobals}${lines.length ? `${lines.join('\n')}\n` : ''}`
}

interface MonacoTypeScriptLike {
  languages: {
    typescript: {
      typescriptDefaults: {
        addExtraLib: (content: string, filePath: string) => { dispose: () => void }
      }
    }
  }
}

// Registry of the mounted code-node editors. Keyed by a per-component instance
// id rather than the node id, so the same scene rendered in two panels does not
// have one unmount pull the declarations out from under the other.
const entries = new Map<string, CodeNodeArgsEntry>()
let monacoInstance: MonacoTypeScriptLike | null = null
let activeNodeId: string | null = null
let appliedContent: string | null = null
let appliedLib: { dispose: () => void } | null = null

function apply(): void {
  if (!monacoInstance) {
    return
  }
  const content = buildCodeNodeDeclarations([...entries.values()], activeNodeId)
  if (content === appliedContent) {
    return
  }
  // Dispose before re-adding: monaco keys extra libs by path, and adding the
  // same path twice without disposing keeps the older content.
  appliedLib?.dispose()
  appliedLib = monacoInstance.languages.typescript.typescriptDefaults.addExtraLib(content, codeNodeTypesPath)
  appliedContent = content
}

export function registerCodeNodeArgs(
  monaco: MonacoTypeScriptLike,
  instanceKey: string,
  nodeId: string,
  codeArgs: CodeArg[]
): void {
  monacoInstance = monaco
  entries.set(instanceKey, { nodeId, codeArgs })
  apply()
}

export function unregisterCodeNodeArgs(instanceKey: string): void {
  const entry = entries.get(instanceKey)
  if (!entry) {
    return
  }
  entries.delete(instanceKey)
  if (activeNodeId === entry.nodeId && ![...entries.values()].some((other) => other.nodeId === entry.nodeId)) {
    activeNodeId = null
  }
  if (entries.size === 0) {
    appliedLib?.dispose()
    appliedLib = null
    appliedContent = null
    return
  }
  apply()
}

/** The code node whose editor has focus wins every name collision. */
export function setActiveCodeNode(nodeId: string | null): void {
  if (activeNodeId === nodeId) {
    return
  }
  activeNodeId = nodeId
  apply()
}
