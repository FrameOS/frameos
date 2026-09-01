#!/usr/bin/env node
// Runs the CLI straight from the TypeScript sources through tsx, so the
// workspace needs no build step (same launcher shape as packages/mcp).
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
