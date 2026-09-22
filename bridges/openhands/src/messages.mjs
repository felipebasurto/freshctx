export function asRequest(payload) {
  if (Array.isArray(payload)) return { messages: payload };
  if (payload && typeof payload === 'object' && Array.isArray(payload.messages)) return payload;
  throw new Error('Expected an OpenHands Chat Completions request with messages');
}

function toolCallId(call) {
  if (!call || typeof call !== 'object' || typeof call.id !== 'string' || call.id.length === 0) return null;
  return call.id;
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    return null;
  }
  return parts.join('');
}

export function replaceContent(content, text) {
  if (!Array.isArray(content)) return text;
  if (content.length === 1 && content[0] && typeof content[0] === 'object') {
    return [{ ...content[0], type: content[0].type ?? 'text', text }];
  }
  return [{ type: 'text', text }];
}

function usesContentBlocks(messages) {
  return messages.some(message => message && Array.isArray(message.content));
}

export function projectionMessage(projection, messages) {
  return {
    role: 'user',
    content: usesContentBlocks(messages) ? [{ type: 'text', text: projection }] : projection,
  };
}

export function indexToolResults(payload) {
  const request = asRequest(payload);
  const byId = new Map();
  const calls = new Set();
  for (const message of request.messages) {
    if (!message || typeof message !== 'object') throw new Error('Invalid native message');
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = toolCallId(call);
        if (!id || calls.has(id)) throw new Error('Duplicate or invalid tool call ID');
        calls.add(id);
      }
    }
    if (message.role !== 'tool') continue;
    if (typeof message.tool_call_id !== 'string' || byId.has(message.tool_call_id) || !calls.has(message.tool_call_id)) {
      throw new Error('Unpaired or duplicate tool result');
    }
    byId.set(message.tool_call_id, message);
  }
  return { request, byId };
}

export function lineSlice(text, { offset, limit }) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (offset > Math.max(1, lines.length)) throw new Error('offset is past the end of the file');
  const raw = lines.slice(offset - 1, offset - 1 + limit).join('');
  const sliced = raw.replace(/(?:\r?\n)+$/u, '') || raw;
  const start = Buffer.byteLength(lines.slice(0, offset - 1).join(''));
  const end = start + Buffer.byteLength(sliced);
  return { text: sliced, start, end, totalLines: lines.length };
}

export function resolveLineWindow(params, lineCount) {
  if (Array.isArray(params.view_range)) {
    const start = params.view_range[0];
    const end = params.view_range[1];
    if (!Number.isSafeInteger(start) || start < 1) throw new Error('view_range start must be a positive integer');
    if (end === undefined || end === -1) return { offset: start, limit: Math.max(1, lineCount - start + 1) };
    if (!Number.isSafeInteger(end) || end < start) throw new Error('view_range end must be -1 or >= start');
    return { offset: start, limit: end - start + 1 };
  }
  if (params.start != null) {
    if (!Number.isSafeInteger(params.start) || params.start < 1) throw new Error('start must be a positive integer');
    const end = params.end === undefined || params.end === -1 ? lineCount : params.end;
    if (!Number.isSafeInteger(end) || end < params.start) throw new Error('end must be -1 or >= start');
    return { offset: params.start, limit: end - params.start + 1 };
  }
  const offset = params.offset ?? 1;
  const limit = params.limit ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('offset and limit must be positive integers');
  }
  return { offset, limit };
}
