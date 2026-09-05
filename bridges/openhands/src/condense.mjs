import { asRequest, contentText } from './messages.mjs';
import { COMPOSE_ORDER } from './config.mjs';

export { COMPOSE_ORDER };

// OpenHands LLMSummarizingCondenser runs on the event view before messages
// are serialized. FreshCtx rewrites only that already-condensed model-bound
// copy so the current projection is eligible and is not summarized away.
export function condenseThenFreshCtx(payload, condense, rewrite) {
  if (typeof condense !== 'function' || typeof rewrite !== 'function') {
    throw new Error('condense and rewrite must be functions');
  }
  return rewrite(condense(payload));
}

function isToolResult(message, resultId) {
  return message?.role === 'tool' && message.tool_call_id === resultId;
}

function isAssistantCall(message, resultId) {
  return message?.role === 'assistant' && Array.isArray(message.tool_calls)
    && message.tool_calls.some(call => call?.id === resultId);
}

// Deterministic stand-in for OpenHands LLMSummarizingCondenser on a
// model-bound Chat Completions copy. Forgotten observations stay inactive
// until the host reads them again. Summaries are not refreshed.
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
    if (forgotten.size === 0) return true;
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

export function forgottenResultIds(payload) {
  const request = asRequest(payload);
  return Array.isArray(request.forgotten_result_ids) ? [...request.forgotten_result_ids] : [];
}

export function summaryContains(payload, snippet) {
  const request = asRequest(payload);
  return request.messages.some(message => {
    if (message?.role !== 'user') return false;
    const text = contentText(message.content);
    return text != null && text.includes(snippet);
  });
}
