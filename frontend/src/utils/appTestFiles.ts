/**
 * `<name>.test.ts` (or .tsx/.js/.jsx) among a JavaScript app's sources: its
 * tests, run in the editor in the app's own interpreter
 * (docs/js-apps-and-code-nodes.md, "Testing an app"). The same rule as the
 * runtime's (js_runtime/app_tests.nim) and both control planes', which take
 * these files out of what an ESP32 receives.
 */
export function isAppTestFile(name: string): boolean {
  return /\.test\.(ts|tsx|js|jsx)$/i.test(name)
}

export function appTestFiles(sources: Record<string, string> | null | undefined): string[] {
  return Object.keys(sources ?? {})
    .filter(isAppTestFile)
    .sort()
}
