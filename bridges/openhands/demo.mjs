import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from './src/bridge.mjs';
import { COMPOSE_ORDER } from './src/config.mjs';
import { summarizeMessages } from './src/condense.mjs';
import { auditRewrite, codePresence } from './src/audit.mjs';

const stale = 'RATE = 10';
const current = 'RATE = 20';
const unread = 'def unread';
const oldSource = `${stale}\nCURRENCY = "EUR"\n\n${unread}():\n    return "outside the read"\n`;
const currentSource = oldSource.replace(stale, current);

function request(text, resultId = 'read_1') {
  return { model: 'openhands-fixture', messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Read the first two lines of price.py.' },
    { role: 'assistant', content: null, tool_calls: [{ id: resultId, type: 'function', function: { name: 'file_editor', arguments: '{"command":"view","path":"price.py","view_range":[1,2]}' } }] },
    { role: 'tool', tool_call_id: resultId, name: 'file_editor', content: text },
  ] };
}

export async function runPairedAudit({ condense = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-openhands-demo-'));
  const outcomes = { compose_order: COMPOSE_ORDER, host: 'openhands-sdk LLMSummarizingCondenser + Chat Completions messages', provider: 'deterministic local request rewrite; no LLM' };
  try {
    await writeFile(join(root, 'price.py'), oldSource);
    const enabledBridge = new Bridge({ root, sessionId: 'paired' });
    try {
      await enabledBridge.ready;
      const read = await enabledBridge.read('read_1', { path: 'price.py', view_range: [1, 2] });
      await writeFile(join(root, 'price.py'), currentSource);
      const native = request(read.content[0].text);
      const disabled = new Bridge({ root, sessionId: 'without', enabled: false });
      try {
        const without = await disabled.rewrite(native, { stale, current, unread });
        const withoutAudit = auditRewrite({ original: native, rewritten: without, enabled: false, stale, current, unread });
        outcomes.withoutFreshCtx = {
          ...withoutAudit.rewritten,
          projection_inserted: withoutAudit.projection_inserted,
          historical_results_replaced: withoutAudit.historical_results_replaced,
        };
        assert.equal(withoutAudit.rewritten.stale_present, true);
        assert.equal(withoutAudit.rewritten.current_present, false);

        if (!condense) {
          const withRewrite = await enabledBridge.rewrite(native, { stale, current, unread });
          const withAudit = auditRewrite({ original: native, rewritten: withRewrite, enabled: true, stale, current, unread });
          outcomes.withFreshCtx = {
            ...withAudit.rewritten,
            projection_inserted: withAudit.projection_inserted,
            historical_results_replaced: withAudit.historical_results_replaced,
          };
          assert.equal(withAudit.rewritten.stale_present, false);
          assert.equal(withAudit.rewritten.current_present, true);
          assert.equal(withAudit.rewritten.unread_present, false);
          return outcomes;
        }

        const condensed = summarizeMessages(native, {
          forgottenResultIds: ['read_1'],
          summary: `The agent previously observed ${stale} in price.py.`,
          keepFirst: 2,
        });
        const forgotten = await enabledBridge.rewrite(condensed, { stale, current, unread });
        const forgottenPresence = codePresence(forgotten, { stale, current, unread });
        outcomes.withFreshCtx = {
          forgotten_stale_present: forgottenPresence.stale_present,
          forgotten_current_present: forgottenPresence.current_present,
        };
        assert.equal(forgottenPresence.stale_present, true, 'condenser summaries are outside the freshness contract');
        assert.equal(forgottenPresence.current_present, false, 'forgotten observations must not silently refresh');

        const reread = await enabledBridge.read('read_2', { path: 'price.py', view_range: [1, 2] });
        const next = request(reread.content[0].text, 'read_2');
        const restored = await enabledBridge.rewrite(next, { stale, current, unread });
        const restoredAudit = auditRewrite({ original: next, rewritten: restored, enabled: true, stale, current, unread });
        outcomes.withFreshCtx.reread = restoredAudit.rewritten;
        assert.equal(restoredAudit.rewritten.stale_present, false);
        assert.equal(restoredAudit.rewritten.current_present, true);
        return outcomes;
      } finally {
        await disabled.close();
      }
    } finally {
      await enabledBridge.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const condense = process.argv.includes('--condense');
  console.log(JSON.stringify(await runPairedAudit({ condense }), null, 2));
}
