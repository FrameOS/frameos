// monaco-editor has no node entry point (browser-only ESM), so any frontend
// logic that imports it for a type or an enum — editAppLogic's
// MarkerSeverity — cannot even be resolved under vitest. vitest.config.ts
// aliases the package here; nothing in the test suite opens an editor.
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
export const editor = {};
