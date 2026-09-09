import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const [label, args] of [
  ["check", ["run", "check"]],
  ["test", ["test"]],
  ["pack:check", ["run", "pack:check"]],
]) {
  const result = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.error(`${label}: ok`);
}
