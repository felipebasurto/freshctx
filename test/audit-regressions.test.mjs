import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { content, decodedProjection, sessionFor, workspaceFor } from './helpers.mjs';
import { serveJsonLines } from '../src/jsonl.mjs';

test('an unavailable observed file can be reopened and later refreshed', async t => {
  const root = await workspaceFor(t);
  const session = await sessionFor(t, root);
  await session.observe({ resultId: 'r', path: 'gone.py', content: content('VALUE = 1\n'), range: null, turn: 1 });
  await session.store.close();
  const reopened = await sessionFor(t, root);
  await writeFile(path.join(root, 'gone.py'), 'VALUE = 2\n');
  const plan = await reopened.prepare({ requestId: 'q', resultIds: ['r'], budgetBytes: 4096 });
  assert.match(decodedProjection(plan), /VALUE = 2/);
  assert.doesNotMatch(decodedProjection(plan), /VALUE = 1/);
});

test('missing region fingerprints omit that unit without breaking valid observations', async t => {
  const root = await workspaceFor(t, { 'a.py': 'VALUE = 1\n', 'b.py': 'SAFE = 2\n' });
  const session = await sessionFor(t, root);
  const r = await session.observe({ resultId: 'r', path: 'a.py', content: content('VALUE = 1'), range: { startByte: 0, endByte: 9 }, turn: 1 });
  await session.observe({ resultId: 'b', path: 'b.py', content: content('SAFE = 2\n'), range: null, turn: 2 });
  delete session.store.state.units[r.unit_id].referentRevision;
  const plan = await session.prepare({ requestId: 'q', resultIds: ['r', 'b'], budgetBytes: 4096 });
  assert.match(decodedProjection(plan), /SAFE = 2/);
  assert.doesNotMatch(decodedProjection(plan), /VALUE = 1/);
  assert.equal(plan.unresolved.find(x => x.result_id === 'r').reason, 'unknown_revision');
});

test('an edited occurrence must not relocate to its unchanged duplicate', async t => {
  const before = 'HEAD = 0\nVALUE = 1\nMID = 0\nVALUE = 1\nTAIL = 9\n';
  const root = await workspaceFor(t, { 'a.py': before });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: 'r', path: 'a.py', content: content('VALUE = 1'), range: { startByte: 9, endByte: 18 }, turn: 1 });
  await writeFile(path.join(root, 'a.py'), before.replace('VALUE = 1', 'VALUE = 9'));
  const plan = await session.prepare({ requestId: 'q', resultIds: ['r'], budgetBytes: 4096 });
  assert.doesNotMatch(decodedProjection(plan), /VALUE = 1/);
  assert.ok(plan.selected.length === 0 || decodedProjection(plan).includes('VALUE = 9'));
});

test('JSONL counts whitespace in complete frames and at EOF', async () => {
  for (const ending of ['\n', '']) {
    const input = new PassThrough();
    const output = new PassThrough();
    let result = '';
    output.on('data', chunk => { result += chunk; });
    let dispatched = 0;
    const run = serveJsonLines({ input, output, maxLineBytes: 32, handle: async () => { dispatched++; return { ok: true }; } });
    input.end(' '.repeat(40) + '{}' + ending);
    await run;
    assert.equal(dispatched, 0);
    assert.equal(JSON.parse(result).error.code, 'request_too_large');
  }
});

test('two occurrences with identical fingerprints retain distinct identities', async t => {
  const pad = '#' + 'x'.repeat(150) + '\n';
  const body = pad + 'VALUE = 1\n' + pad + 'VALUE = 1\n' + pad;
  const root = await workspaceFor(t, { 'a.py': body });
  const session = await sessionFor(t, root);
  const ids = [];
  for (const start of [pad.length, pad.length * 2 + 10]) {
    const observed = await session.observe({ resultId: String(start), path: 'a.py', content: content('VALUE = 1'), range: { startByte: start, endByte: start + 9 }, turn: 1 });
    ids.push(observed.unit_id);
  }
  assert.notEqual(ids[0], ids[1]);
  await session.store.close();
  const reopened = await sessionFor(t, root);
  await writeFile(path.join(root, 'a.py'), '# changed\n' + body);
  const plan = await reopened.prepare({ requestId: 'q', resultIds: [String(pad.length), String(pad.length * 2 + 10)], budgetBytes: 4096 });
  assert.equal(plan.selected.length, 0, 'indistinguishable moved occurrences must be omitted');
  assert.equal(plan.unresolved.length, 2);
});
