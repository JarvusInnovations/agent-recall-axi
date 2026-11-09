/**
 * The `agent-recall-axi/render` subpath (specs/api.md#resume-pack, specs/architecture.md#library--cli):
 * the renderer the `resume-pack` command uses, so a library caller prints the CLI's exact bytes.
 */
export { renderResumePack, type RenderResumeOpts } from "../output/resume.js";
export type { ResumePack } from "../lib/resume.js";
