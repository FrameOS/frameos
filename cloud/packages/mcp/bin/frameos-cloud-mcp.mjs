#!/usr/bin/env node
// Runs the stdio server straight from the TypeScript sources through tsx,
// so the workspace needs no build step for a local MCP process.
import { register } from "tsx/esm/api";

register();
await import("../src/stdio.ts");
