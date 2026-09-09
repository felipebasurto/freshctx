import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { revisionFor } from 'freshctx/hash';
import { openWorkspace, readStableText } from 'freshctx/workspace';
import { Client } from './client.mjs';

const EMPTY_TOOL_OUTPUT = '(no tool output)';

export class Bridge {
  constructor({ root, sessionId, budgetBytes = 131072, client = new Client({ root }) }) {
    this.root = root;
    this.client = client;
    this.budgetBytes = budgetBytes;
    this.ready = client.request('hello', {
      session_id: sessionId,
      adapter: 'freshctx-pi/openai-completions',
      capabilities: { request_rewrite: true, stable_result_identity: true, projection_insertion: true, shared_workspace: true },
    });
  }

  async read(resultId, { path, offset = 1, limit = 200 }) {
    await this.ready;
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('offset and limit must be positive integers');
    const workspace = await openWorkspace(this.root);
    const sourcePath = isAbsolute(path) ? relative(workspace.root, path) : path;
    const snapshot = await readStableText(workspace, sourcePath);
    const lines = snapshot.text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    if (offset > Math.max(1, lines.length)) throw new Error('offset is past the end of the file');
    const raw = lines.slice(offset - 1, offset - 1 + limit).join('');
    const withoutTerminalSeparators = raw.replace(/(?:\r?\n)+$/u, '');
    const text = withoutTerminalSeparators || raw;
    const start = Buffer.byteLength(lines.slice(0, offset - 1).join(''));
    const end = start + Buffer.byteLength(text);
    await this.client.request('observe', {
      result_id: resultId, path: snapshot.path, content_utf8_base64: Buffer.from(text).toString('base64'),
      ...(end > start ? { range: { start_byte: start, end_byte: end } } : {}),
    });
    return { content: [{ type: 'text', text }], details: { path: snapshot.path, startByte: start, endByte: end, totalLines: lines.length } };
  }

  async rewrite(payload) {
    await this.ready;
    if (!payload || !Array.isArray(payload.messages)) throw new Error('Expected a Chat Completions request');
    const byId = new Map();
    const calls = new Set();
    for (const message of payload.messages) {
      if (!message || typeof message !== 'object') throw new Error('Invalid native message');
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (typeof call.id !== 'string' || calls.has(call.id)) throw new Error('Duplicate or invalid tool call ID');
          calls.add(call.id);
        }
      }
      if (message.role !== 'tool') continue;
      if (typeof message.tool_call_id !== 'string' || byId.has(message.tool_call_id) || !calls.has(message.tool_call_id)) throw new Error('Unpaired or duplicate tool result');
      byId.set(message.tool_call_id, message);
    }
    const plan = await this.client.request('prepare', {
      request_id: randomUUID(), result_ids: [...byId.keys()], budget_bytes: this.budgetBytes,
    });
    const projection = Buffer.from(plan.projection_utf8_base64, 'base64').toString('utf8');
    if (revisionFor(projection) !== plan.projection_sha256 || Buffer.byteLength(projection) > this.budgetBytes) throw new Error('Invalid projection hash or budget');
    const replacements = new Map();
    for (const replacement of plan.replacements) {
      const result = byId.get(replacement.result_id);
      const text = result?.content === EMPTY_TOOL_OUTPUT && replacement.expected_sha256 === revisionFor('') ? '' : result?.content;
      if (typeof text !== 'string' || revisionFor(text) !== replacement.expected_sha256 || typeof replacement.marker !== 'string' || replacements.has(replacement.result_id)) throw new Error('Native tool result changed; entire FreshCtx plan discarded');
      replacements.set(replacement.result_id, replacement.marker);
    }
    const copy = structuredClone(payload);
    for (const message of copy.messages) {
      if (message.role === 'tool' && replacements.has(message.tool_call_id)) message.content = replacements.get(message.tool_call_id);
    }
    if (projection) copy.messages.push({ role: 'user', content: projection });
    const committed = await this.client.request('commit', { plan_id: plan.plan_id });
    if (committed.applied !== true) throw new Error('FreshCtx did not commit');
    return copy;
  }

  async close() { await this.client.close(); }
}
