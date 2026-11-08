#!/usr/bin/env node
// Version fast path first (no command graph loaded), then the real CLI.
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../src/version.js";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  // stdin only for the home view's hook mode, and only when it asks (src/hook.ts).
  await main(process.argv.slice(2), { stdin: () => process.stdin });
}
