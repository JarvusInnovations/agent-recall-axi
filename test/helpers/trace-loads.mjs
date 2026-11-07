// Records every module URL the process resolves and prints them to stderr at exit.
import { registerHooks } from "node:module";

const seen = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    seen.push(result.url);
    return result;
  },
});
process.on("exit", () => {
  process.stderr.write(`LOADED ${JSON.stringify(seen)}\n`);
});
