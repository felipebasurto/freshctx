import test from 'node:test';
import { runDemo } from '../demo.mjs';

test('real Pi final HTTP request refreshes a mid-session header edit', { timeout: 30000 }, async () => {
  await runDemo();
});

test('real Pi cancels HTTP dispatch when native history fails validation', { timeout: 30000 }, async () => {
  await runDemo({ failure: 'altered-result' });
});

test('real Pi cancels HTTP dispatch if the FreshCtx child dies after a read', { timeout: 30000 }, async () => {
  await runDemo({ failure: 'child-exit' });
});

test('real Pi resumes a saved read after a function moves and uses its current code', { timeout: 30000 }, async () => {
  await runDemo({ resume: true });
});
