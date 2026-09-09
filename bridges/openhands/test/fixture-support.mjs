import { asRequest, contentText } from '../src/messages.mjs';

function isToolResult(message, resultId) {
  return message?.role === 'tool' && message.tool_call_id === resultId;
}

function isAssistantCall(message, resultId) {
  return message?.role === 'assistant'
    && Array.isArray(message.tool_calls)
    && message.tool_calls.some(call => call?.id === resultId);
}

export function summarizeMessages(payload, {
  forgottenResultIds = [],
  summary,
  keepFirst = 2,
} = {}) {
  const request = asRequest(payload);
  if (typeof summary !== 'string' || summary.length === 0) throw new Error('summary must be a non-empty string');
  if (!Number.isSafeInteger(keepFirst) || keepFirst < 0) throw new Error('keepFirst must be a non-negative integer');
  const forgotten = new Set(forgottenResultIds);
  const messages = request.messages.filter(message => {
    for (const resultId of forgotten) {
      if (isToolResult(message, resultId) || isAssistantCall(message, resultId)) return false;
    }
    return true;
  });
  const insertAt = Math.min(keepFirst, messages.length);
  const usesBlocks = messages.some(message => Array.isArray(message?.content));
  messages.splice(insertAt, 0, {
    role: 'user',
    content: usesBlocks ? [{ type: 'text', text: summary }] : summary,
  });
  return { ...request, messages, forgotten_result_ids: [...forgotten] };
}

export function codePresence(payload, { stale, current, unread } = {}) {
  const text = asRequest(payload).messages
    .map(message => contentText(message?.content))
    .filter(part => part !== null)
    .join('\n');
  return {
    stale_present: typeof stale === 'string' && stale.length > 0 ? text.includes(stale) : false,
    current_present: typeof current === 'string' && current.length > 0 ? text.includes(current) : false,
    unread_present: typeof unread === 'string' && unread.length > 0 ? text.includes(unread) : false,
  };
}

function replacedResultIds(original, rewritten) {
  const before = asRequest(original);
  const after = asRequest(rewritten);
  const replaced = [];
  const count = Math.min(before.messages.length, after.messages.length);
  for (let index = 0; index < count; index += 1) {
    const left = before.messages[index];
    const right = after.messages[index];
    if (left?.role !== 'tool' || right?.role !== 'tool') continue;
    if (left.tool_call_id !== right.tool_call_id) continue;
    if (contentText(left.content) !== contentText(right.content)) replaced.push(left.tool_call_id);
  }
  return replaced;
}

export function auditRewrite({ original, rewritten, enabled, stale, current, unread } = {}) {
  return {
    enabled: Boolean(enabled),
    original: codePresence(original, { stale, current, unread }),
    rewritten: codePresence(rewritten, { stale, current, unread }),
    historical_results_replaced: replacedResultIds(original, rewritten),
    projection_inserted: asRequest(rewritten).messages.length > asRequest(original).messages.length,
  };
}

export function assertPairedFreshness(audit, { requireCurrent = true } = {}) {
  if (!audit?.enabled) {
    if (audit.rewritten.current_present) throw new Error('without-FreshCtx arm must not receive current code');
    return audit;
  }
  if (audit.rewritten.stale_present) throw new Error('with-FreshCtx arm leaked stale observed code');
  if (requireCurrent && !audit.rewritten.current_present) throw new Error('with-FreshCtx arm missing current observed code');
  if (audit.rewritten.unread_present) throw new Error('unread code must stay omitted');
  return audit;
}
