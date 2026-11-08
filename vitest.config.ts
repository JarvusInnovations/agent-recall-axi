import { defineConfig } from "vitest/config";

/**
 * Tests that assert wall-clock bounds (the 200 MB streaming test, the bin start-up floor) run in
 * their own project, after the unit project has finished and one file at a time, so a parallel
 * neighbour cannot eat their budget.
 */
const PERF = ["test/large.test.ts", "test/bin.test.ts", "test/home-perf.test.ts", "test/hook-perf.test.ts"];

export default defineConfig({
  test: {
    globalSetup: ["test/helpers/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Only this project's tests, never the vendored skills under .agents/.
          include: ["test/**/*.test.ts"],
          exclude: PERF,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "perf",
          include: PERF,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
