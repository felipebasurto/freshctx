import { publicError } from "./errors.mjs";
import { runServer } from "./server.mjs";
import { cleanStore, initializeStore } from "./store.mjs";
import { verifyTreeSitterAssets } from "./treesitter.mjs";
import { addWorkspaceExclude, openWorkspace } from "./workspace.mjs";

const USAGE = [
  "Usage:",
  "  freshctx init [--root <workspace>]",
  "  freshctx serve --stdio [--root <workspace>]",
  "  freshctx clean [--root <workspace>]",
  "  freshctx doctor",
].join("\n");

function usageError(message) {
  process.stderr.write(`${message ? `${message}\n` : ""}${USAGE}\n`);
  return 2;
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { root: process.cwd(), stdio: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--stdio") {
      options.stdio = true;
      continue;
    }
    if (argument === "--root") {
      const root = rest[++index];
      if (!root) throw new Error("--root requires a workspace path");
      options.root = root;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    return usageError(error.message);
  }
  const { command, options } = parsed;
  try {
    switch (command) {
      case "init": {
        const workspace = await openWorkspace(options.root);
        await initializeStore(workspace);
        return report({ initialized: true, workspace: workspace.root, git_exclude_updated: await addWorkspaceExclude(workspace) });
      }
      case "clean": {
        const workspace = await openWorkspace(options.root);
        return report({ cleaned: await cleanStore(workspace), workspace: workspace.root });
      }
      case "serve":
        if (!options.stdio) return usageError("freshctx serve requires --stdio");
        await runServer({ root: options.root });
        return 0;
      case "doctor":
        return report({ healthy: true, languages: await verifyTreeSitterAssets() });
      default:
        return usageError();
    }
  } catch (error) {
    const details = publicError(error);
    process.stderr.write(`${details.code}: ${details.message}\n`);
    return 1;
  }
}
