/**
 * The public-repo scrub gate (scripts/scrub-check.sh, specs/architecture.md#ci): it passes on this
 * tree and fails on each kind of planted marker. Markers are assembled at run time and planted in
 * a throwaway git repository, so no marker ever exists in this one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO } from "./helpers/run.js";

const SCRIPT = join(REPO, "scripts", "scrub-check.sh");
const tmp = mkdtempSync(join(tmpdir(), "asa-scrub-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function scrub(cwd: string) {
  const r = spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

let n = 0;
/** A fresh git repository holding one untracked file with the given text. */
function plant(text: string, file = "notes.md"): string {
  const dir = join(tmp, `r${n++}`);
  mkdirSync(dir);
  expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), `${text}\n`);
  return dir;
}

const j = (...parts: string[]) => parts.join("");

describe("scrub gate", () => {
  it("passes on this repository's tree", () => {
    const r = scrub(REPO);
    expect(r.out).toMatch(/files clean/);
    expect(r.status).toBe(0);
  });

  it.each([
    ["home path", j("/ho", "me/", "alice/notes.md")],
    ["home path", j("/Us", "ers/", "bob/src")],
    ["home path", j("/ho", "me/", "linuxbrew/.linuxbrew")], // allowed only inside the bundle
    ["email address", j("carol", "@", "mail-host", ".com")],
    ["email address", j("dave", "@", "widgets", ".us")],
    ["uuid literal", j("9b1deb4d", "-3b7d-4bad-9bdd-", "2b0d7b3dcb6d")],
  ])("fails on a planted %s (%s)", (rule, marker) => {
    const r = scrub(plant(`see ${marker} for details`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`scrub: ${rule} found`);
    expect(r.out).toContain(marker.replace(/\/(?:notes\.md|src|\.linuxbrew)$/, ""));
  });

  it("allows the synthetic values the specs and fixtures use", () => {
    const synthetic = [
      j("/ho", "me/", "user/src/widget"),
      j("/Us", "ers/", "user/src"),
      j("someone", "@", "example", ".test"),
      j("ops", "@", "example", ".com"),
      j("7a2f1c3e", "-0000-4000-8000-", "000000000000"),
    ].join(" ");
    const r = scrub(plant(synthetic));
    expect(r.out).toMatch(/files clean/);
    expect(r.status).toBe(0);
  });

  it("allows any uuid under test/fixtures/", () => {
    const r = scrub(plant(j("9b1deb4d", "-3b7d-4bad-9bdd-", "2b0d7b3dcb6d"), "test/fixtures/x.jsonl"));
    expect(r.status).toBe(0);
  });

  it("never scans node_modules/ or dist/", () => {
    const dir = plant("clean");
    for (const d of ["node_modules/pkg", "dist"]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "x.js"), j("/ho", "me/", "alice/x"));
    }
    expect(scrub(dir).status).toBe(0);
  });
});
