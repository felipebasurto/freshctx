import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPairedAudit } from '../demo.mjs';

test('paired with vs without FreshCtx: current projection vs stale tool body', async () => {
  const outcomes = await runPairedAudit();
  assert.deepEqual(outcomes.withoutFreshCtx, {
    stale_present: true,
    current_present: false,
    unread_present: false,
    projection_inserted: false,
    historical_results_replaced: [],
  });
  assert.equal(outcomes.withFreshCtx.stale_present, false);
  assert.equal(outcomes.withFreshCtx.current_present, true);
  assert.equal(outcomes.withFreshCtx.unread_present, false);
  assert.equal(outcomes.withFreshCtx.projection_inserted, true);
  assert.deepEqual(outcomes.withFreshCtx.historical_results_replaced, ['read_1']);
  assert.equal(outcomes.compose_order, 'condense_then_freshctx');
});

test('paired condensation: forgotten reads stay stale until a new exact read', async () => {
  const outcomes = await runPairedAudit({ condense: true });
  assert.equal(outcomes.withoutFreshCtx.stale_present, true);
  assert.equal(outcomes.withoutFreshCtx.current_present, false);
  assert.equal(outcomes.withFreshCtx.forgotten_stale_present, true);
  assert.equal(outcomes.withFreshCtx.forgotten_current_present, false);
  assert.equal(outcomes.withFreshCtx.reread.stale_present, false);
  assert.equal(outcomes.withFreshCtx.reread.current_present, true);
});

test('without arm is a pure pass-through even after the file changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-openhands-disabled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'price.py'), 'RATE = 10\n');
  const { Bridge } = await import('../src/bridge.mjs');
  const bridge = new Bridge({ root, sessionId: 'disabled', enabled: false });
  t.after(() => bridge.close());
  const payload = { messages: [{ role: 'user', content: 'RATE = 10' }] };
  await writeFile(join(root, 'price.py'), 'RATE = 20\n');
  const rewritten = await bridge.rewrite(payload);
  assert.deepEqual(rewritten, payload);
  await assert.rejects(bridge.read('read_1', { path: 'price.py' }), /disabled/);
});
