import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this project's tests, never the vendored skills under .agents/.
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
