// Types for build-playground-scenes.mjs, read by src/lib/playground.test.ts.
export const excludedTemplates: Set<string>;
export const leadingTemplates: string[];
export const playgroundLayoutId: string;
export function playgroundScenes(): Array<{ id: string; name?: string; settings?: Record<string, unknown> }>;
