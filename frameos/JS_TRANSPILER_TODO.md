# Native JS Transpiler TODO

FrameOS used Sucrase 3.35.1 through `assets/compiled/vendor/sucrase.js` for
device-side TypeScript/JSX compilation. The goal of this work is to replace that
QuickJS-hosted compiler step with native compiled Nim code while keeping the
implementation easy to compare with upstream Sucrase.

## Upstream Reference

- Project: <https://github.com/alangpierce/sucrase>
- Upstream Sucrase version tracked by FrameOS dependencies: `3.35.1`
  (`pnpm-lock.yaml`)
- Reference source archive used for this port: GitHub `main` downloaded on
  2026-06-05 to `/private/tmp/sucrase-src`
- License: MIT. Sucrase credits Alan Pierce, Babel/Babylon, and Acorn
  contributors. Keep attribution in `src/frameos/js_runtime/transpiler.nim`.

## Sucrase Concepts To Mirror

- [x] Public `transform(code, options)` shape with `TransformOptions` and
  `TransformResult`.
- [x] Initial parser/tokenizer model equivalent to `src/parser` and generated
  `TokenType`, including native token formatting and Sucrase token-label
  parity fixtures.
- [x] Initial `TokenProcessor`-style rewrite stream with original whitespace/comment
  preservation and input/output mappings.
- [ ] `RootTransformer` transformer ordering and prefix/suffix/hoisted code.
- [x] FrameOS classic JSX runtime output using `__frameosJsx` and
  `__frameosFragment`.
- [x] JSX fragment lowering and common/numeric entity decoding for FrameOS
  classic JSX output.
- [ ] Full `JSXTransformer` parity, including automatic runtime, dev metadata,
  full JSX entity table, key edge cases, and display names.
- [x] Initial `TypeScriptTransformer`-style erasure for common annotations,
  `as` assertions, interfaces, type aliases, and type-only imports/exports.
- [x] TypeScript enum lowering following Sucrase `processEnum` output shape,
  including numeric reverse mappings and string enum members.
- [x] Generic type parameter/type argument erasure for common functions,
  arrows, classes, and calls.
- [x] TypeScript-only modifier erasure for common class/member syntax.
- [x] TypeScript assertion erasure inside template literal interpolations and
  semicolon-free FrameOS app code.
- [x] Definite-assignment and optional member annotation erasure for common
  class/member syntax.
- [x] Preserve runtime identifiers/object keys named `type` while still
  removing real type aliases and interfaces.
- [x] Preserve runtime object keys/property access named `as` or `satisfies`
  while still removing TypeScript assertions.
- [x] Remove common `declare` statements, abstract class members, and lower
  constructor parameter properties for Sucrase-compatible runtime behavior.
- [ ] Full TypeScript parser parity, including mapped types, conditional types,
  decorators, namespaces/modules, overloads, robust method return-type handling,
  and complete ambiguity handling.
- [x] Initial import/export transform for FrameOS app modules:
  `export const`, `export function`, `export default`, and `export { ... }`.
- [x] Static value imports lower to CommonJS declarations for bare, default,
  namespace, named, mixed default+named, and TypeScript `import = require`.
- [x] Re-export forms lower for `export { ... } from`, `export * as`, and
  `export * from`.
- [x] Broader export declarations lower for multiple exported variables,
  `export async function`, and `export default async function`.
- [ ] Full `CJSImportProcessor`/`CJSImportTransformer` parity, including
  Babel/Sucrase interop helpers, live binding updates, dynamic import behavior,
  shadowed global analysis, and import elision based on runtime identifier use.
- [x] Preserve modern ES syntax supported by current QuickJS, including
  optional chaining/nullish coalescing, numeric separators, optional catch
  binding, regex literals, and class fields. No transform is needed while the
  bundled QuickJS runtime accepts these forms.
- [ ] ES transform parity for syntax not accepted by the bundled QuickJS
  runtime, if any future required FrameOS codepath needs it.
- [ ] Source map support equivalent to `computeSourceMap`.
- [ ] Diagnostic token formatting equivalent to `getFormattedTokens`.

## Current FrameOS Integration State

- [x] Added native transpiler at `src/frameos/js_runtime/transpiler.nim`.
- [x] `js_runtime/runtime.nim` calls the native transpiler instead of evaluating
  Sucrase in a separate QuickJS compiler runtime.
- [x] Kept `cleanupCompilerJs` as a no-op compatibility test helper.
- [x] Removed `assets/compiled/vendor/sucrase.js` from the frame frontend build
  and Nim asset module generation path.
- [x] Removed backend QuickJS validation of the Sucrase vendor bundle. Backend
  source validation still uses the npm `sucrase` package from
  `frameos/frontend` so editor/API validation can keep Sucrase-compatible
  diagnostics until the native Nim transpiler has a CLI or service boundary.

## Tests

- [x] Add focused Nim unit tests for TypeScript erasure, JSX lowering, and app
  module export rewriting.
- [x] Verified focused runtime coverage after enum/import/generic/JSX updates:
  `nim c -r src/frameos/tests/test_js_transpiler.nim`,
  `nim c -r src/frameos/tests/test_js_runtime_helpers.nim`, and
  `nim c -r src/frameos/tests/test_js_app_runtime.nim`.
- [x] Build a fixture runner that compares native output or runtime behavior
  against Sucrase for selected upstream test cases.
- [x] Added a Sucrase/npm parity harness at
  `tools/tests/test_native_js_transpiler_parity.py` with selected upstream-style
  TypeScript/JSX/module runtime fixtures.
- [x] Added enum fixtures.
- [x] Added import/re-export fixtures.
- [x] Added regressions for multiple typed variable declarators, method return
  types, and ternary/object-literal initializers in generated runtime envelopes.
- [x] Added runtime coverage for typed template literal interpolations in
  dynamic JS app modules.
- [x] Added dynamic runtime coverage for the current JS text/image/logic repo
  app template codepaths.
- [x] Added transform and dynamic runtime coverage for modern ES syntax that
  current QuickJS can execute directly.

## Native Port Plan

Target: native Nim transpilation should accept almost any single-file
TypeScript/JSX that npm Sucrase accepts, except for features that inherently
require multi-file module resolution or non-FrameOS runtime dependencies.
FrameOS should keep classic JSX output using `__frameosJsx` and
`__frameosFragment`.

Sucrase's tokenizer can be ported, but not in isolation. Its transforms depend
on parser/traverser annotations layered onto tokens:

- Type context (`token.isType`) so removals are unambiguous.
- Declaration roles for identifiers.
- Import/export binding roles and type-only elision metadata.
- JSX tag/child roles.
- Optional-chain/nullish boundaries.
- Scope depth and shadowed-global analysis for import helper decisions.
- Token start/end spans for whitespace/comment preservation and source maps.

The relevant upstream source slice is roughly 9.4k TypeScript lines before
supporting utilities:

- `src/parser/tokenizer/*`
- `src/parser/traverser/*`
- `src/parser/plugins/typescript.ts`
- `src/parser/plugins/jsx/index.ts`
- `src/TokenProcessor.ts`
- Current FrameOS-relevant transformers:
  `TypeScriptTransformer.ts`, `JSXTransformer.ts`, `CJSImportTransformer.ts`,
  and the ES preservation/transform helpers.

### Phase 0: Parity Harness First

Keep growing `tools/tests/test_native_js_transpiler_parity.py` before and during
the port. The harness should remain the main confidence gate:

- Transform each fixture with npm `sucrase` from `frameos/frontend`.
- Transform the same fixture with native Nim via `tools/native_js_transpile.nim`.
- Execute both transformed outputs under Node/QuickJS-compatible semantics.
- Compare runtime results instead of exact formatting whenever possible.
- Keep expected failures explicit only when they represent known native gaps.

Fixture categories to add from upstream Sucrase tests:

- TypeScript erasure: annotations, predicates, overloads, abstract/declare,
  type-only imports/exports, non-null assertions, `as`, and `satisfies`.
- TypeScript runtime transforms: enums and constructor parameter properties.
- JSX classic runtime: tags, fragments, spreads, children, text, entities,
  comments, nested JSX, member tags, and whitespace edge cases.
- Imports/exports: default, named, namespace, re-export, type-only elision,
  `import = require`, and mixed import forms.
- Ambiguity cases: JSX vs generics, generic arrows, `x < y > z`, regex vs
  division, runtime identifiers named `type`/`as`/`satisfies`/`declare`.
- Modern ES preservation: optional chaining/nullish coalescing, class fields,
  numeric separators, optional catch binding, regex literals, BigInt, async,
  private fields if bundled QuickJS supports them.
- Error cases: malformed TS/JSX that should produce useful diagnostics.

### Phase 1: Token Model

Port Sucrase token structures into Nim:

- [x] `TokenType` values.
- [x] Contextual keywords.
- [x] Token object fields: `type`, `start`, `end`, `scopeDepth`, `isType`,
  `identifierRole`, `jsxRole`, optional-chain/nullish metadata, etc.
- [x] `formatTokenType`/formatted token support for diagnostics and tests.

Deliverable:

- [x] `js_runtime/tokens.nim` or equivalent.
- [x] Token formatting tests adapted from upstream `tokens-test.ts`.

### Phase 2: Tokenizer

Port raw tokenization:

- [x] Identifiers and contextual keywords.
- [x] Strings, templates, and `${...}` template nesting.
- [x] Numbers, BigInts, decimals, numeric separators.
- [x] Punctuation/operators including `?.`, `??`, `=>`, `...`, `#`, etc.
- [x] Comments and whitespace preservation by source spans.
- [x] Regex tokenization via expression-context slash handling.
- [x] JSX token mode.
- [x] TypeScript token extensions.

Deliverable:

- [x] A token stream for valid JS/TS/JSX, but still no rewriting.
- [x] Token parity tests against selected upstream token cases.

### Phase 3: Parser/Traverser Annotations

Port enough of Sucrase's parser/traverser to annotate tokens. This is what turns
the tokenizer into a useful transpiler input:

- [x] Initial statement/expression annotation pass for common FrameOS/Sucrase
  fixture shapes.
- [x] TypeScript plugin-style marking for common type contexts and type-only
  declarations.
- [x] JSX plugin-style marking for tag/child roles.
- [x] Binding/declaration role marking.
- [x] Import/export role marking.
- [x] Scope depth and context-id marking for common blocks/classes/functions.
- [x] Optional-chain/nullish boundary marking, even if FrameOS usually preserves
  those ES forms.
- [ ] Full recursive-descent parser parity and shadowed-global analysis for all
  Sucrase import helper decisions.

Deliverable:

- [x] `File(tokens, scopes)` equivalent via `js_runtime/parser.nim`.
- [ ] Native parser errors that can be mapped to source locations.

### Phase 4: TokenProcessor

Port Sucrase's rewrite stream:

- [x] Preserve original whitespace/comments between tokens.
- [x] Replace/remove/copy tokens.
- [x] Lookahead/snapshots for ambiguous transforms.
- [x] Balanced code removal.
- [x] Input/output mappings, initially for debugging and later for source maps.

Deliverable:

- [x] Token-driven output builder via `js_runtime/token_processor.nim`.
- Heuristic string-splicing should start being retired.

### Phase 5: TypeScript Transformer

Replace scanner-based TypeScript erasure with token-driven behavior:

- Type annotations and return types.
- Type parameters and type arguments.
- Interfaces, type aliases, mapped/conditional/indexed-access types.
- Type-only imports/exports and unknown type-only export elision.
- `declare`, `abstract`, TS modifiers, overloads.
- Enums and const enums.
- Constructor parameter properties.
- Non-null assertions, `as`, and `satisfies`.
- Decorators only if current Sucrase behavior and FrameOS use cases require it.

Deliverable:

- Selected upstream `typescript-test.ts` parity fixtures pass.

### Phase 6: JSX Transformer

Replace scanner-based JSX lowering with token-driven classic FrameOS JSX output:

- Emit `__frameosJsx(...)` and `__frameosFragment`.
- Support fragments, tag names, member names, prop spreads, boolean props,
  expression props, nested JSX, children, text, comments, and entities.
- Keep automatic runtime/dev metadata out of FrameOS unless a future codepath
  needs it.

Deliverable:

- Selected upstream `jsx-test.ts` classic runtime fixtures pass after adapting
  output expectations to FrameOS runtime calls.

### Phase 7: Import/Export Transformer

Move module rewriting onto token roles:

- `export const/function/class/default`.
- Named exports and empty exports.
- Re-exports and namespace exports.
- Default/named/namespace imports.
- Type-only import/export elision.
- `import = require`.
- Babel/Sucrase interop helpers only where FrameOS/runtime behavior actually
  needs them.

Deliverable:

- Selected upstream `imports-test.ts` fixtures pass for single-file/runtime-safe
  cases.

### Phase 8: ES Transform Policy

Current policy: preserve ES syntax accepted by bundled QuickJS instead of
lowering it. Tests already cover optional chaining, nullish coalescing, numeric
separators, optional catch binding, regex literals, and class fields.

Only port ES transformers when the bundled QuickJS cannot execute a syntax form
that FrameOS users should reasonably paste. Candidate upstream transformers:

- `OptionalChainingNullishTransformer.ts`
- `NumericSeparatorTransformer.ts`
- `OptionalCatchBindingTransformer.ts`

### Phase 9: Diagnostics and Source Maps

After token/parser parity is in place:

- Port formatted token output for debugging.
- Improve native error messages and source locations.
- Add source-map support equivalent to `computeSourceMap` if editor/runtime
  workflows need original source positions.

### Cutover Criteria

Native transpilation is shippable as the default when:

- The parity harness covers a representative slice of upstream TypeScript, JSX,
  import/export, ambiguity, and modern ES preservation cases.
- No known failures remain for common single-file TypeScript users may paste
  into FrameOS apps/snippets.
- Existing focused Nim runtime tests pass.
- `flox activate -c 'nimble build'` passes.
- Backend/editor validation can either keep npm Sucrase or call into native
  diagnostics with equivalent quality.

Until then, keep npm Sucrase available in backend validation and be conservative
about removing any working JS fallback that catches broader TypeScript syntax.

## Resume Notes

The current implementation is a compatibility slice for FrameOS runtime code and
selected Sucrase-style fixtures. It has grown beyond the original app-template
surface, but it is still not a full Sucrase port. The next best work is to grow
the parity harness with upstream cases, then port token model/tokenizer/parser
pieces and replace heuristic scanner passes one transformer at a time.
