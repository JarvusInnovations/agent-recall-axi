#!/usr/bin/env node
// Version fast path first (no command graph loaded), then the real CLI.
import { tryFastPath } from "axi-sdk-js/fast-path";
import { fstatSync } from "node:fs";
import { VERSION } from "../src/version.js";

/** A pipe, socket or file on fd 0 can carry a hook payload; a TTY or /dev/null cannot, so it is never opened. */
function payloadStdin(): NodeJS.ReadStream | undefined {
  try {
    const st = fstatSync(0);
    return st.isFIFO() || st.isSocket() || st.isFile() ? process.stdin : undefined;
  } catch {
    return undefined;
  }
}

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  // stdin only for the home view's hook mode, and only when it asks (src/hook.ts).
  await main(process.argv.slice(2), { stdin: payloadStdin });
}
