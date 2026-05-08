import { transform } from 'sucrase'

type TransformName = 'jsx' | 'typescript' | 'imports'

interface TranspileOptions {
  filePath?: string
  transforms?: TransformName[]
}

const defaultTransforms: TransformName[] = ['typescript', 'jsx']

const fragmentMarker = Symbol.for('frameos.fragment')

const normalizeChildren = (children: unknown[]): unknown => {
  if (children.length === 0) {
    return undefined
  }
  if (children.length === 1) {
    return children[0]
  }
  return children
}

;(globalThis as typeof globalThis & Record<string, unknown>).__frameosFragment = fragmentMarker
;(globalThis as typeof globalThis & Record<string, unknown>).__frameosJsx = (
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): unknown => {
  const nextProps = props ? { ...props } : {}
  const explicitChildren = normalizeChildren(children)
  const propChildren = Object.prototype.hasOwnProperty.call(nextProps, 'children') ? nextProps.children : undefined

  if (Object.prototype.hasOwnProperty.call(nextProps, 'children')) {
    delete nextProps.children
  }

  const normalizedChildren = explicitChildren ?? propChildren
  if (type === fragmentMarker) {
    return normalizedChildren ?? null
  }

  if (normalizedChildren !== undefined) {
    nextProps.children = normalizedChildren
  }

  return {
    type,
    props: nextProps,
  }
}

;(globalThis as typeof globalThis & Record<string, unknown>).__frameosTranspile = (
  code: string,
  options: TranspileOptions = {}
): string => {
  const result = transform(code, {
    filePath: options.filePath ?? '<frameos>',
    transforms: options.transforms ?? defaultTransforms,
    jsxRuntime: 'classic',
    jsxPragma: '__frameosJsx',
    jsxFragmentPragma: '__frameosFragment',
    production: true,
  })
  return result.code
}
