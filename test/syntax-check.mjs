import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = readdirSync(path.join(root, "src"))
  .filter((name) => name.endsWith(".mjs"))
  .sort()
  .map((name) => path.join(root, "src", name));
const files = [path.join(root, "bin/freshctx.mjs"), ...sources];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
