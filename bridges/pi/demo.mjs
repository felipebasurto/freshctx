import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

export async function runDemo({ failure = null, resume = false, missingState = false } = {}) {
  assert.ok(!failure || !resume, 'Failure and resume fixtures are separate');
  const sourcePath = resume ? 'price.js' : 'price.py';
  const oldSource = resume
    ? 'function total(quantity) {\n  return quantity * 10;\n}\n'
    : 'RATE = 10\nCURRENCY = "EUR"\n\ndef unread():\n    return "outside the read"\n';
  const currentSource = resume
    ? '// inserted above the observed function\nconst unread = "not observed";\n\nfunction total(quantity) {\n  return quantity * 20;\n}\n'
    : oldSource.replace('RATE = 10', 'RATE = 20');
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
      let answer;
      if (resume && turn === 3) {
        const source = captured.at(-1).messages
          .filter(message => message.role === 'tool' || message.role === 'user')
          .map(message => typeof message.content === 'string' ? message.content : '').join('\n');
        const functions = [...source.matchAll(/function total\(quantity\) \{\n  return quantity \* \d+;\n\}/gu)];
        assert.equal(functions.length, 1, 'Task needs exactly one complete function in the request');
        answer = runInNewContext(functions[0][0] + '; total(3)', {}, { timeout: 100 });
      }
      const delta = read
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read_price', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: sourcePath, offset: 1, limit: resume ? 3 : 2 }) } }] }
        : { role: 'assistant', content: answer === undefined ? 'Fixture response. Inspect the captured request for evidence.' : JSON.stringify({ answer }) };
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
    for (const enabled of failure || missingState ? [true] : [false, true]) {
      turn = 0;
      captured.length = 0;
      await writeFile(join(root, sourcePath), oldSource);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const errors = [];
      const openSession = async sessionManager => {
        const loader = new DefaultResourceLoader({
          cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: enabled ? [fileURLToPath(new URL('./extension.js', import.meta.url))] : [],
          extensionFactories: failure ? [pi => {
            pi.on('tool_result', async event => {
              await writeFile(join(root, sourcePath), currentSource);
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
        const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel('freshctx-fixture', 'fixture'), thinkingLevel: 'off', tools: ['read'], resourceLoader: loader, sessionManager, settingsManager });
        await session.bindExtensions({ onError: error => errors.push(error) });
        return session;
      };
      const manager = resume ? SessionManager.create(root, join(root, 'sessions')) : SessionManager.inMemory(root);
      let session = await openSession(manager);
      try {
        await session.prompt(`Read the first ${resume ? 'three' : 'two'} lines of ${sourcePath}.`);
        if (failure) {
          assert.equal(captured.length, 1, 'Rejected native result must never reach HTTP dispatch');
          assert.equal(session.messages.at(-1).stopReason, 'aborted');
          return { rejectedRequestSent: false, stopReason: 'aborted' };
        }
        assert.equal(captured.length, 2, 'Pi must execute the read and send its result');
        let savedHistory;
        if (resume) {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
          session.dispose();
          session = null;
          savedHistory = await readFile(manager.getSessionFile(), 'utf8');
          assert.ok(savedHistory.includes('quantity * 10'), 'Pi must persist the original tool body');
        }
        await writeFile(join(root, sourcePath), currentSource);
        if (resume) {
          if (missingState) await rm(join(root, '.freshctx'), { recursive: true });
          const reopened = SessionManager.open(manager.getSessionFile());
          assert.equal(reopened.getSessionId(), manager.getSessionId());
          session = await openSession(reopened);
        }
        await session.prompt(resume ? 'Using the available function, compute total(3).' : 'Inspect the code context already available.');
        if (missingState) {
          assert.equal(captured.length, 2, 'Untracked saved read must never reach resumed HTTP dispatch');
          assert.equal(session.messages.at(-1).stopReason, 'aborted');
          return { rejectedRequestSent: false, stopReason: 'aborted' };
        }
        assert.equal(captured.length, 3);
        const outgoing = JSON.stringify(captured.at(-1).messages);
        if (resume) {
          const expected = runInNewContext(await readFile(join(root, sourcePath), 'utf8') + '; total(3)', {}, { timeout: 100 });
          assert.equal(expected, 60);
          assert.equal(session.messages.at(-1).stopReason, 'stop', session.messages.at(-1).errorMessage ?? 'Task must finish with an answer');
          const response = session.messages.at(-1).content.find(block => block.type === 'text')?.text;
          const actual = JSON.parse(response).answer;
          const staleBodyPresent = outgoing.includes('quantity * 10');
          const currentBodyPresent = outgoing.includes('quantity * 20');
          assert.equal(actual, enabled ? expected : 30);
          assert.equal(staleBodyPresent, !enabled);
          assert.equal(currentBodyPresent, enabled);
          assert.equal(outgoing.includes('const unread'), false);
          assert.ok((await readFile(manager.getSessionFile(), 'utf8')).startsWith(savedHistory), 'Resume must preserve saved history');
          outcomes[enabled ? 'withFreshCtx' : 'withoutFreshCtx'] = {
            answer: actual, expected, correct: actual === expected,
            staleBodyPresent, currentBodyPresent,
            requestBytes: Buffer.byteLength(JSON.stringify(captured.at(-1))),
            requests: captured.length,
          };
          assert.deepEqual(errors, []);
          continue;
        }
        outcomes[enabled ? 'withFreshCtx' : 'withoutFreshCtx'] = {
          staleBodyPresent: outgoing.includes('RATE = 10'), currentBodyPresent: outgoing.includes('RATE = 20'),
          unreadBodyPresent: outgoing.includes('def unread'),
        };
        assert.deepEqual(errors, []);
      } finally {
        if (session) {
          await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
          session.dispose();
        }
      }
    }
    if (resume) return { host: '@earendil-works/pi-coding-agent@0.85.0', task: 'persist-read-edit-move-resume-total', provider: 'scripted code consumer over HTTP; no LLM or billing measurement', ...outcomes };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runDemo({ resume: process.argv.includes('--resume') }), null, 2));
