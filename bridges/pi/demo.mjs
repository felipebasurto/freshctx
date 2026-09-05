import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

// Real Pi tool execution and HTTP serialization, deterministic provider fixture.
// This deliberately measures request bytes, never model answer quality.
export async function runDemo({ failure = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'freshctx-pi-demo-'));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  const captured = [];
  let turn = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      captured.push(JSON.parse(body));
      const read = turn++ === 0;
      const delta = read
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read_price', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'price.py', offset: 1, limit: 2 }) } }] }
        : { role: 'assistant', content: 'Fixture response. Inspect the captured request for evidence.' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false });
  modelRuntime.registerProvider('freshctx-fixture', {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-fixture-no-secret',
    models: [{ id: 'fixture', name: 'Deterministic local fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
  });
  const outcomes = {};
  try {
    for (const enabled of failure ? [true] : [false, true]) {
      turn = 0;
      captured.length = 0;
      await writeFile(join(root, 'price.py'), 'RATE = 10\nCURRENCY = "EUR"\n\ndef unread():\n    return "outside the read"\n');
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: enabled ? [fileURLToPath(new URL('./extension.js', import.meta.url))] : [],
        extensionFactories: failure ? [pi => {
          pi.on('tool_result', async event => {
            await writeFile(join(root, 'price.py'), 'RATE = 20\nCURRENCY = "EUR"\n\ndef unread():\n    return "outside the read"\n');
            if (failure === 'altered-result') return { content: [{ type: 'text', text: event.content[0].text + '\nChanged by another extension' }] };
            if (failure === 'child-exit') {
              const directory = join(root, '.freshctx', 'locks');
              const locks = (await readdir(directory)).filter(name => name.endsWith('.lock') && name !== 'lifecycle.lock');
              assert.equal(locks.length, 1);
              const pid = Number((await readFile(join(directory, locks[0]), 'utf8')).trim());
              assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
              process.kill(pid, 'SIGKILL');
            }
          });
        }] : [],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel('freshctx-fixture', 'fixture'), thinkingLevel: 'off', tools: ['read'], resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager });
      const errors = [];
      await session.bindExtensions({ onError: error => errors.push(error) });
      try {
        await session.prompt('Read the first two lines of price.py.');
        if (failure) {
          assert.equal(captured.length, 1, 'Rejected native result must never reach HTTP dispatch');
          assert.equal(session.messages.at(-1).stopReason, 'aborted');
          return { rejectedRequestSent: false, stopReason: 'aborted' };
        }
        assert.equal(captured.length, 2, 'Pi must execute the read and send its result');
        await writeFile(join(root, 'price.py'), 'RATE = 20\nCURRENCY = "EUR"\n\ndef unread():\n    return "outside the read"\n');
        await session.prompt('Inspect the code context already available.');
        assert.equal(captured.length, 3);
        const outgoing = JSON.stringify(captured.at(-1).messages);
        outcomes[enabled ? 'withFreshCtx' : 'withoutFreshCtx'] = {
          staleBodyPresent: outgoing.includes('RATE = 10'), currentBodyPresent: outgoing.includes('RATE = 20'),
          unreadBodyPresent: outgoing.includes('def unread'),
        };
        assert.deepEqual(errors, []);
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
        session.dispose();
      }
    }
    assert.deepEqual(outcomes, {
      withoutFreshCtx: { staleBodyPresent: true, currentBodyPresent: false, unreadBodyPresent: false },
      withFreshCtx: { staleBodyPresent: false, currentBodyPresent: true, unreadBodyPresent: false },
    });
    return { host: '@earendil-works/pi-coding-agent@0.85.0', provider: 'local deterministic Chat Completions fixture; no LLM', ...outcomes };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runDemo(), null, 2));
