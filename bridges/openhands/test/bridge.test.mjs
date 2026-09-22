import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Client } from 'freshctx/client';
import { configFromEnv } from '../src/config.mjs';
import { auditRewrite, assertPairedFreshness, summarizeMessages } from './fixture-support.mjs';

const body = '# café\r\nRATE = 10\r\n\r\ndef total():\r\n    return RATE\r\n';

function request(text, { blocks = false } = {}) {
  const toolContent = blocks ? [{ type: 'text', text }] : text;
  return { model: 'openhands-fixture', messages: [
    { role: 'system', content: blocks ? [{ type: 'text', text: 'You are a coding agent.' }] : 'You are a coding agent.' },
    { role: 'user', content: blocks ? [{ type: 'text', text: 'Inspect the rate.' }] : 'Inspect the rate.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'file_editor', arguments: '{"command":"view","path":"price.py"}' } }] },
    { role: 'tool', tool_call_id: 'read_1', name: 'file_editor', content: toolContent },
  ] };
}

async function fixture(t, { enabled = true, sessionId = 'test' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-openhands-test-'));
  await writeFile(join(root, 'price.py'), body);
  const bridge = new Bridge({
    root,
    sessionId,
    enabled,
  });
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  await bridge.ready;
  return { root, bridge };
}

test('ranged UTF-8 CRLF header read refreshes only observed range, never infers absence', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', limit: 2 });
  assert.equal(read.content[0].text, '# café\r\nRATE = 10');
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const original = request(read.content[0].text);
  const rewritten = await bridge.rewrite(original, { stale: 'RATE = 10', current: 'RATE = 20', unread: 'def total' });
  assert.match(JSON.stringify(rewritten), /RATE = 20/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10|def total/);
  assert.equal(original.messages[3].content, read.content[0].text);
  assert.equal(rewritten.messages[3].tool_call_id, 'read_1');
});

test('OpenHands view_range and content blocks rewrite the same observed bytes', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', view_range: [1, 2] });
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const rewritten = await bridge.rewrite(request(read.content[0].text, { blocks: true }), { stale: 'RATE = 10', current: 'RATE = 20' });
  assert.equal(rewritten.messages.at(-1).content[0].type, 'text');
  assert.match(rewritten.messages.at(-1).content[0].text, /RATE = 20/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10/);
});

test('changed and duplicate native results reject the whole plan without mutation', async t => {
  const { bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  const original = request(read.content[0].text + ' changed by another extension');
  const before = structuredClone(original);
  await assert.rejects(bridge.rewrite(original), /Native tool result changed/);
  assert.deepEqual(original, before);
  const duplicate = request(read.content[0].text);
  duplicate.messages.push(duplicate.messages[3]);
  await assert.rejects(bridge.rewrite(duplicate), /duplicate tool result/);
});

test('budget and deletion replace historical bodies with unavailable markers', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  bridge.budgetBytes = 0;
  const empty = await bridge.rewrite(request(read.content[0].text));
  assert.doesNotMatch(JSON.stringify(empty), /RATE = 10/);
  assert.equal(empty.messages.length, 4);
  await rm(join(root, 'price.py'));
  bridge.budgetBytes = 131072;
  const deleted = await bridge.rewrite(request(read.content[0].text));
  assert.doesNotMatch(JSON.stringify(deleted), /RATE = 10/);
});

test('symlinks and traversal fail before content is returned', async t => {
  const { root, bridge } = await fixture(t);
  await symlink(join(root, 'price.py'), join(root, 'link.py'));
  await assert.rejects(bridge.read('read_1', { path: 'link.py' }));
  await assert.rejects(bridge.read('read_2', { path: '../outside.py' }));
});

test('commit detects a file edit after prepare; caller still has original payload', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  const send = bridge.client.request.bind(bridge.client);
  bridge.client.request = async (op, fields) => {
    if (op === 'commit') await writeFile(join(root, 'price.py'), body.replace('10', '20'));
    return send(op, fields);
  };
  const original = request(read.content[0].text);
  await assert.rejects(bridge.rewrite(original), { code: 'stale_plan' });
  assert.equal(original.messages.length, 4);
});

test('resume refreshes persisted observations with stable host IDs', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  await bridge.close();
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const resumed = new Bridge({ root, sessionId: 'test' });
  t.after(() => resumed.close());
  const rewritten = await resumed.rewrite(request(read.content[0].text));
  assert.match(JSON.stringify(rewritten), /RATE = 20/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10/);
});

test('dead or stalled child rejects promptly and remains closed', async t => {
  const client = new Client({ args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 50 });
  t.after(() => client.close());
  await assert.rejects(client.request('status'), /timed out/);
  await assert.rejects(client.request('status'), /timed out/);
});

test('condense_then_freshctx keeps the projection eligible and leaves summaries stale', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', limit: 2 });
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const condensed = summarizeMessages(request(read.content[0].text), {
    forgottenResultIds: ['read_1'],
    summary: 'Earlier the file contained RATE = 10.',
    keepFirst: 2,
  });
  const rewritten = await bridge.rewrite(condensed, { stale: 'RATE = 10', current: 'RATE = 20' });
  assert.match(JSON.stringify(rewritten), /RATE = 10/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 20/);
  assert.equal(rewritten.messages.some(message => message.tool_call_id === 'read_1'), false);
  assert.deepEqual(rewritten.forgotten_result_ids, ['read_1']);

  const current = await bridge.read('read_2', { path: 'price.py', view_range: [1, 2] });
  const next = request(current.content[0].text);
  next.messages[2].tool_calls[0].id = 'read_2';
  next.messages[3].tool_call_id = 'read_2';
  const reread = await bridge.rewrite(next, { stale: 'RATE = 10', current: 'RATE = 20', unread: 'def total' });
  assertPairedFreshness(auditRewrite({
    original: next, rewritten: reread, enabled: true, stale: 'RATE = 10', current: 'RATE = 20', unread: 'def total',
  }));
});

test('fall-open config is rejected', () => {
  assert.throws(() => configFromEnv({ FRESHCTX_FALL_OPEN: '1' }), /does not support fall-open/);
});
