import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { revisionFor } from 'freshctx/hash';
import { openWorkspace, readStableText } from 'freshctx/workspace';
import { Client } from './client.mjs';
import { ADAPTER, CAPABILITIES, DEFAULT_BUDGET_BYTES } from './config.mjs';
import { auditRewrite } from './audit.mjs';
import { forgottenResultIds } from './condense.mjs';
import {
  asRequest,
  contentText,
  indexToolResults,
  lineSlice,
  projectionMessage,
  replaceContent,
  resolveLineWindow,
  serializeRequestText,
} from './messages.mjs';

export class Bridge {
  constructor({
    root,
    sessionId,
    budgetBytes = DEFAULT_BUDGET_BYTES,
    enabled = true,
    client,
    onAudit,
  }) {
    this.root = root;
    this.client = enabled ? client ?? new Client({ root }) : null;
    this.budgetBytes = budgetBytes;
    this.enabled = enabled;
    this.onAudit = onAudit;
    this.ready = this.client
      ? this.client.request('hello', {
        session_id: sessionId,
        adapter: ADAPTER,
        capabilities: CAPABILITIES,
      })
      : Promise.resolve();
  }

  async read(resultId, params = {}) {
    if (!this.enabled) throw new Error('FreshCtx is disabled; do not observe in the without arm');
    await this.ready;
    const workspace = await openWorkspace(this.root);
    const sourcePath = isAbsolute(params.path) ? relative(workspace.root, params.path) : params.path;
    const snapshot = await readStableText(workspace, sourcePath);
    const lineCount = (snapshot.text.match(/[^\n]*\n|[^\n]+$/gu) ?? []).length;
    const window = resolveLineWindow(params, Math.max(1, lineCount));
    const slice = lineSlice(snapshot.text, window);
    await this.client.request('observe', {
      result_id: resultId,
      path: snapshot.path,
      content_utf8_base64: Buffer.from(slice.text).toString('base64'),
      ...(slice.end > slice.start ? { range: { start_byte: slice.start, end_byte: slice.end } } : {}),
    });
    return {
      content: [{ type: 'text', text: slice.text }],
      details: { path: snapshot.path, startByte: slice.start, endByte: slice.end, totalLines: slice.totalLines },
    };
  }

  async rewrite(payload, { stale, current, unread } = {}) {
    const original = asRequest(payload);
    if (!this.enabled) {
      const copy = structuredClone(original);
      this.emitAudit({ original, rewritten: copy, enabled: false, stale, current, unread });
      return copy;
    }
    await this.ready;
    const { request, byId } = indexToolResults(original);
    const plan = await this.client.request('prepare', {
      request_id: randomUUID(),
      result_ids: [...byId.keys()],
      budget_bytes: this.budgetBytes,
    });
    const projection = Buffer.from(plan.projection_utf8_base64, 'base64').toString('utf8');
    if (revisionFor(projection) !== plan.projection_sha256 || Buffer.byteLength(projection) > this.budgetBytes) {
      throw new Error('Invalid projection hash or budget');
    }
    const replacements = new Map();
    for (const replacement of plan.replacements) {
      const result = byId.get(replacement.result_id);
      const text = contentText(result?.content);
      if (typeof text !== 'string' || revisionFor(text) !== replacement.expected_sha256 || typeof replacement.marker !== 'string' || replacements.has(replacement.result_id)) {
        throw new Error('Native tool result changed; entire FreshCtx plan discarded');
      }
      replacements.set(replacement.result_id, replacement.marker);
    }
    const copy = structuredClone(request);
    for (const message of copy.messages) {
      if (message.role === 'tool' && replacements.has(message.tool_call_id)) {
        message.content = replaceContent(message.content, replacements.get(message.tool_call_id));
      }
    }
    if (projection) copy.messages.push(projectionMessage(projection, copy.messages));
    const committed = await this.client.request('commit', { plan_id: plan.plan_id });
    if (committed.applied !== true) throw new Error('FreshCtx did not commit');
    this.emitAudit({ original, rewritten: copy, enabled: true, stale, current, unread });
    return copy;
  }

  emitAudit({ original, rewritten, enabled, stale, current, unread }) {
    if (typeof this.onAudit !== 'function') return;
    this.onAudit(auditRewrite({
      original,
      rewritten,
      enabled,
      stale,
      current,
      unread,
      forgottenResultIds: forgottenResultIds(original),
    }));
  }

  requestText(payload) {
    return serializeRequestText(payload);
  }

  async close() { await this.client?.close(); }
}
