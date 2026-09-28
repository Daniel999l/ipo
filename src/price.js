// SOL price in USD for display only. Cached; the site falls back to SOL amounts if it can't be read.
let cache = { at: 0, usd: null };
export async function solUsd(cfg) {
  if (Date.now() - cache.at < 60000) return cache.usd;
  try {
    const r = await fetch(cfg.solPriceUrl, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const v = j?.So11111111111111111111111111111111111111112?.usdPrice ?? j?.data?.So11111111111111111111111111111111111111112?.price ?? j?.solana?.usd;
    cache = { at: Date.now(), usd: v ? Number(v) : cache.usd };
  } catch { cache.at = Date.now(); }
  return cache.usd;
}
