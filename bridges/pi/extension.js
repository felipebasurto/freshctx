import { Type } from '@sinclair/typebox';
import { Bridge } from './src/bridge.mjs';

export default function freshctx(pi) {
  let bridge;
  const supported = ctx => ctx.model?.api === 'openai-completions';
  const getBridge = async ctx => {
    if (!supported(ctx)) throw new Error('freshctx-pi supports openai-completions only; select a compatible model');
    if (!bridge) {
      bridge = new Bridge({ root: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
    }
    await bridge.ready;
    return bridge;
  };
  pi.registerTool({
    name: 'read', label: 'Read with FreshCtx',
    description: 'Read UTF-8 workspace text, at most 512 KiB per file. offset is a one-based line number; limit defaults to 200 lines. Reads only that range. Unread code is not evidence of absence: read the relevant later lines before answering about them. Does not read images or follow symlinks. Current observed code is refreshed before each supported provider request.',
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Read cancelled');
      return (await getBridge(ctx)).read(id, params);
    },
  });
  pi.on('before_provider_request', async (event, ctx) => {
    try {
      const result = await (await getBridge(ctx)).rewrite(event.payload);
      ctx.ui.setStatus('freshctx', 'FreshCtx: current observed code');
      return result;
    } catch (error) {
      // Pi catches thrown hook errors. Cancel its active request signal instead.
      ctx.abort();
      const warning = `FreshCtx blocked: ${error.message}. Request cancelled; no freshness claim.`;
      ctx.ui.setStatus('freshctx', 'FreshCtx: blocked');
      ctx.ui.notify(warning, 'error');
      process.stderr.write(warning + '\n');
      // Discard the complete plan without changing saved history or the payload.
      return undefined;
    }
  });
  pi.on('session_shutdown', async () => {
    const current = bridge;
    bridge = undefined;
    await current?.close();
  });
}
