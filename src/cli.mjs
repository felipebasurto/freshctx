import process from "node:process";

import { publicError } from "./errors.mjs";
import { runServer } from "./server.mjs";
import { cleanStore, initializeStore } from "./store.mjs";
import { verifyTreeSitterAssets } from "./treesitter.mjs";
import { addWorkspaceExclude, openWorkspace } from "./workspace.mjs";

function usage() {
  return [
    "Usage:",
    "  freshctx init [--root <workspace>]",
    "  freshctx serve --stdio [--root <workspace>]",
    "  freshctx clean [--root <workspace>]",
    "  freshctx doctor",
  ].join("\n");
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
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  const { command, options } = parsed;
  try {
    switch (command) {
      case "init": {
        const workspace = await openWorkspace(options.root);
        await initializeStore(workspace);
        const excluded = await addWorkspaceExclude(workspace);
        process.stdout.write(`${JSON.stringify({ initialized: true, workspace: workspace.root, git_exclude_updated: excluded })}\n`);
        return 0;
      }
      case "clean": {
        const workspace = await openWorkspace(options.root);
        const removed = await cleanStore(workspace);
        process.stdout.write(`${JSON.stringify({ cleaned: removed, workspace: workspace.root })}\n`);
        return 0;
      }
      case "serve":
        if (!options.stdio) {
          process.stderr.write(`freshctx serve requires --stdio\n${usage()}\n`);
          return 2;
        }
        await runServer({ root: options.root });
        return 0;
      case "doctor": {
        const languages = await verifyTreeSitterAssets();
        process.stdout.write(`${JSON.stringify({ healthy: true, languages })}\n`);
        return 0;
      }
      default:
        process.stderr.write(`${usage()}\n`);
        return 2;
    }
  } catch (error) {
    const details = publicError(error);
    process.stderr.write(`${details.code}: ${details.message}\n`);
    return 1;
  }
}
