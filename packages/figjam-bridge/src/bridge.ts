#!/usr/bin/env bun
/**
 * CLI entry for the FigJam bridge: `bun run figjam:bridge`. Everything lives in
 * server.ts so other workspaces can embed it with `startBridge`.
 */
import { startBridge } from "./server"

if (import.meta.main) await startBridge()
