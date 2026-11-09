import { describe, expect, it } from "vitest";
import { CACHE_HOME } from "./helpers/run.js";

describe("test helpers", () => {
  it("the run helper reuses the global setup's throwaway cache (removed at teardown) instead of minting one per file", () => {
    expect(process.env.XDG_CACHE_HOME).toMatch(/asa-cache-global-/);
    expect(CACHE_HOME).toBe(process.env.XDG_CACHE_HOME);
  });
});
