import { asRequest, contentText, serializeRequestText } from './messages.mjs';
import { COMPOSE_ORDER } from './config.mjs';

export function codePresence(payload, { stale, current, unread } = {}) {
  const text = serializeRequestText(payload);
  return {
    stale_present: typeof stale === 'string' && stale.length > 0 ? text.includes(stale) : false,
    current_present: typeof current === 'string' && current.length > 0 ? text.includes(current) : false,
    unread_present: typeof unread === 'string' && unread.length > 0 ? text.includes(unread) : false,
  };
}

export function replacedResultIds(original, rewritten) {
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

export function projectionInserted(original, rewritten) {
  return asRequest(rewritten).messages.length > asRequest(original).messages.length;
}

export function auditRewrite({
  original,
  rewritten,
  enabled,
  stale,
  current,
  unread,
  forgottenResultIds = [],
} = {}) {
  const originalPresence = codePresence(original, { stale, current, unread });
  const rewrittenPresence = codePresence(rewritten, { stale, current, unread });
  return {
    compose_order: COMPOSE_ORDER,
    enabled: Boolean(enabled),
    forgotten_result_ids: [...forgottenResultIds],
    original: originalPresence,
    rewritten: rewrittenPresence,
    historical_results_replaced: replacedResultIds(original, rewritten),
    projection_inserted: projectionInserted(original, rewritten),
  };
}

export function assertPairedFreshness(audit, { requireCurrent = true } = {}) {
  if (!audit?.enabled) {
    if (audit.rewritten.current_present) throw new Error('without-FreshCtx arm must not receive current code');
    return audit;
  }
  if (audit.rewritten.stale_present) throw new Error('with-FreshCtx arm leaked stale observed code');
  if (requireCurrent && !audit.rewritten.current_present) throw new Error('with-FreshCtx arm missing current observed code');
  if (audit.rewritten.unread_present) throw new Error('unread code is not evidence of absence and must stay omitted');
  return audit;
}
