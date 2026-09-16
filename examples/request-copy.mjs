import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// This example is a protocol client, not an agent or a model evaluation.
const cli = process.argv[2] ?? fileURLToPath(new URL('../bin/freshctx.mjs', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'freshctx-example-'));
const revision = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const observed = 'function total(quantity) {\n  return quantity * 10;\n}';
const current = observed.replace('* 10', '* 20');
await writeFile(path.join(root, 'price.js'), observed + '\n\nfunction other() { return 99; }\n');
const child = spawn(process.execPath, [cli, 'serve', '--stdio', '--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
const closed = new Promise(resolve => child.once('close', resolve));
const lines = createInterface({ input: child.stdout });
const replies = lines[Symbol.asyncIterator]();
let sequence = 0;
let failure;
child.on('error', error => { failure = error; });
child.stdin.on('error', error => { failure = error; });

async function request(op, fields = {}) {
  if (failure) throw failure;
  const id = String(++sequence);
  child.stdin.write(JSON.stringify({ ...fields, protocol: 'freshctx/1', id, op }) + '\n');
  let timer;
  try {
    const next = await Promise.race([
      replies.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sidecar timed out')), 5000); }),
    ]);
    if (next.done) throw failure ?? new Error('Sidecar exited');
    const reply = JSON.parse(next.value);
    assert.equal(reply.protocol, 'freshctx/1');
    assert.equal(reply.id, id);
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  } finally { clearTimeout(timer); }
}

try {
  await request('hello', { session_id: 'example', capabilities: {
    request_rewrite: true, stable_result_identity: true, projection_insertion: true, shared_workspace: true,
  } });
  await request('observe', {
    result_id: 'read-1', path: 'price.js', content_utf8_base64: Buffer.from(observed).toString('base64'),
    range: { start_byte: 0, end_byte: Buffer.byteLength(observed) },
  });
  const history = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"price.js"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: observed },
    { role: 'user', content: 'What does total(3) return now?' },
  ];
  // Represents an edit between a tool read and the next provider request.
  await writeFile(path.join(root, 'price.js'), '// inserted\n' + current + '\n\nfunction other() { return 99; }\n');
  const plan = await request('prepare', { request_id: 'next-request', result_ids: ['read-1'], budget_bytes: 4096 });
  const projection = Buffer.from(plan.projection_utf8_base64, 'base64').toString('utf8');
  assert.equal(revision(projection), plan.projection_sha256);
  assert.ok(Buffer.byteLength(projection) <= 4096);
  assert.equal(plan.replacements.length, 1);
  const replacement = plan.replacements[0];
  assert.equal(replacement.result_id, 'read-1');
  assert.equal(revision(history[1].content), replacement.expected_sha256);
  const messages = structuredClone(history);
  messages[1].content = replacement.marker;
  if (projection) messages.push({ role: 'user', content: projection });
  assert.equal((await request('commit', { plan_id: plan.plan_id })).applied, true);
  assert.equal(history[1].content, observed);
  assert.ok(projection.includes(current));
  assert.ok(!projection.includes('function other'));
  assert.ok(!JSON.stringify(messages).includes('quantity * 10'));
  console.log(JSON.stringify({
    evidence: 'real sidecar protocol; no provider dispatch or LLM',
    historyPreserved: true, staleBodyRemoved: true, currentSymbolPresent: true,
    unreadFunctionOmitted: true, projectionBytes: Buffer.byteLength(projection),
    projection, outgoingMessages: messages,
  }, null, 2));
} finally {
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
  await closed;
  clearTimeout(timer);
  lines.close();
  await rm(root, { recursive: true, force: true });
}
