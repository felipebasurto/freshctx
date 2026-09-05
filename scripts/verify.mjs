import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--setup')) throw new Error('Usage: npm run verify -- [--setup]');
function run(label, command, args, cwd = root) {
  console.log(`\n${label}`);
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', timeout: 180000,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'freshctx-npm-cache') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`${label}: passed in ${((performance.now() - start) / 1000).toFixed(2)}s`);
}
if (args.includes('--setup')) {
  run('Pi dependency setup', 'npm', ['ci', '--prefix', 'bridges/pi', '--no-audit', '--no-fund']);
  run('OpenHands dependency setup', 'npm', ['ci', '--prefix', 'bridges/openhands', '--no-audit', '--no-fund']);
}
// A copied dependency can silently test another checkout after a worktree move.
try {
  if (realpathSync(new URL('../bridges/pi/node_modules/freshctx', import.meta.url)) !== realpathSync(root)) {
    throw new Error('Pi resolves a different product checkout');
  }
} catch (error) {
  throw new Error('Pi must link to this checkout. Run npm run verify -- --setup.', { cause: error });
}
run('Core syntax', 'npm', ['run', 'check']);
run('Core behavior', 'npm', ['test']);
run('Product package allowlist', 'npm', ['run', 'pack:check']);
run('Pi syntax', 'npm', ['run', 'check', '--prefix', 'bridges/pi']);
run('Pi behavior and loopback HTTP', 'npm', ['test', '--prefix', 'bridges/pi']);
try {
  if (realpathSync(new URL('../bridges/openhands/node_modules/freshctx', import.meta.url)) !== realpathSync(root)) {
    throw new Error('OpenHands resolves a different product checkout');
  }
} catch (error) {
  throw new Error('OpenHands must link to this checkout. Run npm run verify -- --setup.', { cause: error });
}
run('OpenHands syntax', 'npm', ['run', 'check', '--prefix', 'bridges/openhands']);
run('OpenHands behavior', 'npm', ['test', '--prefix', 'bridges/openhands']);
run('OpenHands Python hook', 'python3', ['test/test_hook.py'], fileURLToPath(new URL('../bridges/openhands', import.meta.url)));
