export const DEFAULT_BUDGET_BYTES = 131072;
export const COMPOSE_ORDER = 'condense_then_freshctx';
export const ADAPTER = 'freshctx-openhands/openai-completions';

export const CAPABILITIES = Object.freeze({
  request_rewrite: true,
  stable_result_identity: true,
  projection_insertion: true,
  shared_workspace: true,
});

function truthy(value) {
  return value === '1' || value === 'true';
}

function falsey(value) {
  return value === '0' || value === 'false';
}

export function configFromEnv(env = process.env) {
  if (truthy(env.FRESHCTX_FALL_OPEN)) {
    throw new Error('FreshCtx OpenHands bridge does not support fall-open; rejected plans must cancel dispatch');
  }
  const enabled = env.FRESHCTX_ENABLED === undefined ? true : !falsey(env.FRESHCTX_ENABLED);
  const budget = env.FRESHCTX_BUDGET_BYTES === undefined ? DEFAULT_BUDGET_BYTES : Number(env.FRESHCTX_BUDGET_BYTES);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('FRESHCTX_BUDGET_BYTES must be a non-negative integer');
  const timeoutMs = env.FRESHCTX_TIMEOUT_MS === undefined ? 10000 : Number(env.FRESHCTX_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('FRESHCTX_TIMEOUT_MS must be a positive integer');
  return {
    enabled,
    root: env.FRESHCTX_ROOT,
    sessionId: env.FRESHCTX_SESSION_ID,
    budgetBytes: budget,
    timeoutMs,
    audit: truthy(env.FRESHCTX_AUDIT),
    composeOrder: COMPOSE_ORDER,
  };
}
