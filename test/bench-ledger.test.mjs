import assert from "node:assert/strict";
import test from "node:test";

import { loadPriceCard, priceCycle, splitSerialized, usdMicros } from "../bench/ledger/cache.mjs";
import { serializeRequest } from "../bench/lib/serialize.mjs";

function request(historyText, liveText) {
  return serializeRequest({
    history: [{ kind: "body", resultId: "r1", path: "a.py", text: historyText }],
    liveBlock: liveText,
  });
}

test("identical HISTORY and changed LIVE prices as prefix hit and suffix miss", async () => {
  const priceCard = await loadPriceCard();
  const prev = request("stable-prefix", "live-one");
  const next = request("stable-prefix", "live-two");
  const priced = priceCycle({ prevSerialized: prev, nextSerialized: next, priceCard });
  const parts = splitSerialized(next);
  assert.equal(parts.history.includes("stable-prefix"), true);
  assert.equal(priced.cache_hit_tokens > 0, true);
  assert.equal(priced.cache_miss_tokens > 0, true);
  assert.equal(priced.cache_write_tokens, 0);
  assert.equal(priced.usd_input_micros > 0, true);
});

test("rewritten HISTORY prices as a prefix cache write", async () => {
  const priceCard = await loadPriceCard();
  const prev = request("old-history", "live");
  const next = request("new-history", "live");
  const priced = priceCycle({ prevSerialized: prev, nextSerialized: next, priceCard });
  assert.equal(priced.cache_write_tokens > 0, true);
  assert.equal(priced.cache_hit_tokens > 0, true);
});

test("price card input rate moves usd_input_micros", async () => {
  const priceCard = await loadPriceCard();
  const next = request("only", "x");
  const base = priceCycle({ prevSerialized: null, nextSerialized: next, priceCard });
  const expensive = structuredClone(priceCard);
  expensive.anthropic_sonnet_4_6.input_usd_per_mtok = 30;
  expensive.anthropic_sonnet_4_6.cache_write_5m_usd_per_mtok = 37.5;
  const moved = priceCycle({ prevSerialized: null, nextSerialized: next, priceCard: expensive });
  assert.equal(moved.usd_input_micros > base.usd_input_micros, true);
  assert.equal(usdMicros(1000, 3), 3000);
});
