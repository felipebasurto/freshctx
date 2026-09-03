import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cardPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "price-card-v1.json");

export function estTokens(byteLength, bytesPerToken = 4) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError("byteLength must be a non-negative safe integer");
  }
  if (byteLength === 0) return 0;
  return Math.ceil(byteLength / bytesPerToken);
}

export function splitSerialized(serialized) {
  const marker = "\nLIVE\n";
  const at = serialized.indexOf(marker);
  if (at === -1) throw new Error("serialized request missing LIVE marker");
  return {
    history: serialized.slice(0, at),
    live: serialized.slice(at + marker.length),
  };
}

export function usdMicros(tokens, usdPerMtok) {
  return Math.round(tokens * usdPerMtok);
}

export async function loadPriceCard() {
  return JSON.parse(await readFile(cardPath, "utf8"));
}

export function priceCycle({ prevSerialized, nextSerialized, priceCard, extraCompactCalls = 0 }) {
  const bytesPerToken = priceCard.bytes_per_token;
  const rates = priceCard.anthropic_sonnet_4_6;
  const next = splitSerialized(nextSerialized);
  const histBytes = Buffer.byteLength(next.history, "utf8");
  const liveBytes = Buffer.byteLength(next.live, "utf8");
  const histTokens = estTokens(histBytes, bytesPerToken);
  const liveTokens = estTokens(liveBytes, bytesPerToken);
  const prev = prevSerialized === null || prevSerialized === undefined
    ? null
    : splitSerialized(prevSerialized);
  const historyHit = Boolean(prev && prev.history === next.history);
  const liveHit = Boolean(prev && prev.live === next.live);
  let cache_hit_tokens = 0;
  let cache_miss_tokens = 0;
  let cache_write_tokens = 0;
  if (historyHit) cache_hit_tokens += histTokens;
  else cache_write_tokens += histTokens;
  if (liveHit) cache_hit_tokens += liveTokens;
  else cache_miss_tokens += liveTokens;
  const usd_input_micros =
    usdMicros(cache_hit_tokens, rates.cache_read_usd_per_mtok) +
    usdMicros(cache_miss_tokens, rates.input_usd_per_mtok) +
    usdMicros(cache_write_tokens, rates.cache_write_5m_usd_per_mtok);
  const compactOutput = extraCompactCalls * priceCard.output_stub_tokens_per_compact_call;
  const usd_output_micros = usdMicros(compactOutput, rates.output_usd_per_mtok);
  return {
    est_tokens: histTokens + liveTokens,
    cache_hit_tokens,
    cache_miss_tokens,
    cache_write_tokens,
    usd_input_micros,
    usd_output_micros,
    usd_input: usd_input_micros / 1_000_000,
  };
}

export function priceOutputStubs(apiCalls, priceCard) {
  const tokens = apiCalls * priceCard.output_stub_tokens_per_api_call;
  const usd_output_micros = usdMicros(tokens, priceCard.anthropic_sonnet_4_6.output_usd_per_mtok);
  return { output_stub_tokens: tokens, usd_output_micros };
}
