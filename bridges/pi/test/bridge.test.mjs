import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Client } from 'freshctx/client';

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
test('a read of the whole file without a limit follows the file, including appended code', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py' });
  await writeFile(join(root, 'price.py'), body + '\r\ndef discount():\r\n    return 5\r\n');
  const text = JSON.stringify(await bridge.rewrite(request(read.content[0].text)));
  assert.match(text, /def total/);
  assert.match(text, /def discount/);
});
test('an explicit limit that happens to cover the file stays a range read', async t => {
  const { root, bridge } = await fixture(t);
  const read = await bridge.read('read_1', { path: 'price.py', limit: 200 });
  await writeFile(join(root, 'price.py'), body + '\r\ndef discount():\r\n    return 5\r\n');
  const text = JSON.stringify(await bridge.rewrite(request(read.content[0].text)));
  assert.match(text, /def total/);
  assert.doesNotMatch(text, /def discount/);
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
test('an unknown successful read blocks rewriting, while other tool results survive', async t => {
  const { bridge } = await fixture(t);
  const original = request('RATE = 10');
  await assert.rejects(bridge.rewrite(original), /no observation for a native read/);
  assert.equal(original.messages[1].content, 'RATE = 10');
  const nonRead = request('test output');
  nonRead.messages[0].tool_calls[0].function.name = 'bash';
  assert.deepEqual(await bridge.rewrite(nonRead), nonRead);
  const failed = request('file not found');
  assert.deepEqual(await bridge.rewrite(failed, { failedReadIds: ['read_1'] }), failed);
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
  assert.match(rewritten.messages[1].content, /^\[[0-9a-f]{24}\]$/u);
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

// E11c regressions (freshctx-research labs/jev-stale-view-v1, e11-24 and e11-10):
// a later partial read must not narrow what an earlier wider read tracked.
function method(name, body) {
  return [`    def ${name}(self):`, `        """${name} docs."""`, ...body.map(line => `        ${line}`), ''];
}
function lexerLike(totalLines) {
  const tail = [...method('scan_literal', ['chars = ""', 'while self.peek() not in " \\n":', '    chars += self.consume()', 'return chars']),
    ...method('scan_quoted_literal', ['chars = ""', 'while True:', '    ch = self.peek()', '    if ch == \'"\':', '        break', '    chars += self.consume()', 'return chars'])];
  const lines = ['"""Splits a string into tokens."""', '', 'class Lexer:'];
  for (let index = 0; lines.length + tail.length + 4 <= totalLines; index += 1) lines.push(...method(`scan_${index}`, [`return ${index}`]));
  while (lines.length + tail.length < totalLines) lines.push('    # padding');
  return [...lines, ...tail].join('\n');
}
function reads(texts) {
  const messages = [];
  texts.forEach((text, index) => {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `read_${index + 1}`, type: 'function', function: { name: 'read', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `read_${index + 1}`, content: text });
  });
  return { model: 'test', messages: [...messages, { role: 'user', content: 'Question?' }] };
}
const EDIT = ['return chars', 'if chars == "-" and self.peek() in " \\t":\n            return "exclusion"\n        return chars'];
for (const [label, lines] of [['e11-24: 204 lines, default limit then offset 200', 204], ['whole file (180 lines) then offset read', 180]]) {
  test(`${label}: the edited function above the last one stays projected`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'freshctx-pi-e11c-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = lexerLike(lines);
    assert.equal(source.split('\n').length, lines);
    await writeFile(join(root, 'lexer.py'), source);
    const bridge = new Bridge({ root, sessionId: 'e11c' });
    t.after(() => bridge.close());
    const first = await bridge.read('read_1', { path: 'lexer.py' });
    const second = await bridge.read('read_2', { path: 'lexer.py', offset: lines - 4 });
    const literal = source.indexOf('def scan_literal');
    await writeFile(join(root, 'lexer.py'), source.slice(0, literal) + source.slice(literal).replace(...EDIT));
    const copy = await bridge.rewrite(reads([first.content[0].text, second.content[0].text]));
    const projection = copy.messages.at(-1).content;
    assert.match(projection, /if chars == "-" and self\.peek\(\)/);
    assert.match(projection, /def scan_quoted_literal/);
    assert.doesNotMatch(copy.messages.filter(m => m.role === 'tool').map(m => m.content).join(' '), /ambiguous|unresolved/);
  });
}
test('e11-10: overlapping ranged reads keep the region that covers the edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-pi-e11c-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = Array.from({ length: 511 }, (_, index) => `value_${index + 1} = ${index + 1}  # line ${index + 1}`).join('\n');
  await writeFile(join(root, 'utils.py'), source);
  const bridge = new Bridge({ root, sessionId: 'e11c' });
  t.after(() => bridge.close());
  const texts = [];
  let id = 0;
  for (const args of [{}, { offset: 200, limit: 200 }, { limit: 200, offset: 1 }, { limit: 120, offset: 200 }, { limit: 60, offset: 320 }]) {
    texts.push((await bridge.read(`read_${++id}`, { path: 'utils.py', ...args })).content[0].text);
  }
  await writeFile(join(root, 'utils.py'), source.replace('value_335 = 335  # line 335', 'value_335 = 336  # edited'));
  const projection = (await bridge.rewrite(reads(texts))).messages.at(-1).content;
  assert.match(projection, /value_335 = 336  # edited/);
  assert.match(projection, /value_1 = 1  # line 1\n/);
});

test('refresh changed: an unchanged read stays native and nothing is projected until the code changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-pi-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'price.py'), body);
  const bridge = new Bridge({ root, sessionId: 'refresh', refresh: 'changed' });
  t.after(() => bridge.close());
  const read = await bridge.read('read_1', { path: 'price.py', limit: 2 });
  const native = request(read.content[0].text);
  assert.deepEqual(await bridge.rewrite(native), native);
  await writeFile(join(root, 'price.py'), body.replace('10', '20'));
  const changed = await bridge.rewrite(native);
  assert.match(changed.messages[1].content, /^\[[0-9a-f]{24}\]$/);
  assert.match(changed.messages.at(-1).content, /RATE = 20/);
  const tampered = request(read.content[0].text.replace('10', '11'));
  await writeFile(join(root, 'price.py'), body);
  await assert.rejects(bridge.rewrite(tampered), /Native tool result changed/);
});
