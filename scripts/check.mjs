import { stat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function check(target) {
  const entry = await stat(target);
  if (entry.isDirectory()) {
    for (const name of (await readdir(target)).sort()) await check(path.join(target, name));
  } else if (/\.(?:mjs|js)$/u.test(target)) {
    const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

for (const target of process.argv.length > 2 ? process.argv.slice(2) : ['bin', 'src', 'test', 'scripts', 'examples']) {
  await check(target);
}
