import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Client } from '../src/client.mjs';

const body = '# café\r\nRATE = 10\r\n\r\ndef total():\r\n    return RATE\r\n';
function request(text) {
  return { model: 'test', messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read_1', content: text },
    { role: 'user', content: 'What changed?' },
  ] };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-pi-test-'));
  await writeFile(join(root, 'price.py'), body);
  const bridge = new Bridge({ root, sessionId: 'test' });
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  await bridge.ready;
  return { root, bridge };
}
test('ranged UTF-8 CRLF header read refreshes only observed range, never infers absence', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', limit: 2 });
  assert.equal(read.content[0].text, '# café\r\nRATE = 10');
  assert.equal(read.details.endByte, Buffer.byteLength(read.content[0].text));
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const original = request(read.content[0].text);
  const rewritten = await bridge.rewrite(original);
  assert.match(JSON.stringify(rewritten), /RATE = 20/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10|def total/);
  assert.equal(original.messages[1].content, read.content[0].text);
  assert.equal(rewritten.messages[1].tool_call_id, 'read_1');
});
test('later read reaches unread symbols; no whole-file workaround', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', offset: 4, limit: 2 });
  await writeFile(join(root, 'price.py'), body.replace('return RATE', 'return RATE * 2'));
  const rewritten = await bridge.rewrite(request(read.content[0].text));
  assert.match(JSON.stringify(rewritten), /return RATE \* 2/);
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10/);
});
test('a blank-line-only read never becomes an implicit whole-file read', async t => {
  const { bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', offset: 3, limit: 1 });
  assert.equal(read.content[0].text, '\r\n');
  const rewritten = await bridge.rewrite(request(read.content[0].text));
  assert.doesNotMatch(JSON.stringify(rewritten), /RATE = 10|def total/);
});
test('changed and duplicate native results reject the whole plan without mutation', async t => {
  const { bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  const original = request(read.content[0].text + ' changed by another extension');
  const before = structuredClone(original);
  await assert.rejects(bridge.rewrite(original), /Native tool result changed/);
  assert.deepEqual(original, before);
  const duplicate = request(read.content[0].text);
  duplicate.messages.push(duplicate.messages[1]);
  await assert.rejects(bridge.rewrite(duplicate), /duplicate tool result/);
});
test('budget and deletion replace historical bodies with unavailable markers', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  bridge.budgetBytes = 0;
  const empty = await bridge.rewrite(request(read.content[0].text));
  assert.doesNotMatch(JSON.stringify(empty), /RATE = 10/);
  assert.equal(empty.messages.length, 3);
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
  assert.equal(original.messages.length, 3);
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

test('moved-symbol and tax-base projection headers are not Pi line offsets', async t => {
  const { root, bridge } = await fixture(t);
  const symbol = 'def tax_base(amount):\n    return amount * 2\n#\n';
  assert.equal(Buffer.byteLength(symbol, 'utf8'), 46);
  const tax = `${symbol}${'#'.repeat(76)}`;
  assert.equal(Buffer.byteLength(tax, 'utf8'), 122);
  await writeFile(join(root, 'tax.py'), tax);
  const read = await bridge.read('read_1', { path: 'tax.py', offset: 1, limit: 2 });
  assert.equal(read.content[0].text, 'def tax_base(amount):\n    return amount * 2');
  await writeFile(join(root, 'tax.py'), `${'# inserted\n'.repeat(8)}${tax}`);
  const rewritten = await bridge.rewrite(request(read.content[0].text));
  const projection = rewritten.messages.at(-1).content;
  const header = String(projection).slice(0, String(projection).indexOf('\n'));
  assert.equal(/:\d+$/u.test(header), false, `projection header still looks like a line offset: ${header}`);
  assert.match(header, /bytes$/u);
  assert.match(header, /:symbol:/u);
  assert.match(String(projection), /return amount \* 2/u);
  assert.ok(46 > read.details.totalLines, `byte length 46 used as offset is past EOF (${read.details.totalLines} lines)`);
  assert.ok(122 > read.details.totalLines, `byte length 122 used as offset is past EOF (${read.details.totalLines} lines)`);
  assert.match(rewritten.messages[1].content, /^\[[0-9a-f]{8}\]$/u);
});

test('resume follows a moved symbol; compacted results stay inactive until read again', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', offset: 4, limit: 2 });
  await bridge.close();
  await writeFile(join(root, 'price.py'), '# inserted\n# another line\n' + body.replace('return RATE', 'return RATE * 2'));
  const resumed = new Bridge({ root, sessionId: 'test' });
  t.after(() => resumed.close());
  const rewritten = await resumed.rewrite(request(read.content[0].text));
  assert.match(rewritten.messages.at(-1).content, /return RATE \* 2/);
  assert.doesNotMatch(rewritten.messages.at(-1).content, /inserted|RATE = 10/);

  const requestWithoutNativeRead = { model: 'test', messages: [{ role: 'user', content: 'Continue after compaction' }] };
  assert.deepEqual(await resumed.rewrite(requestWithoutNativeRead), requestWithoutNativeRead);
  const current = await resumed.read('read_2', { path: 'price.py', offset: 6, limit: 2 });
  const next = request(current.content[0].text);
  next.messages[0].tool_calls[0].id = 'read_2';
  next.messages[1].tool_call_id = 'read_2';
  const reread = await resumed.rewrite(next);
  assert.match(reread.messages.at(-1).content, /return RATE \* 2/);
  assert.doesNotMatch(JSON.stringify(reread), /read_1/);
});
