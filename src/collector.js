// Moves each coin's creator fees into its handle vault and keeps market stats and chart points fresh.
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { distributeInstructions, pendingFees, curveState, canonicalPumpPoolPda, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './pump.js';
import { sendIxs } from './tx.js';

const SUPPLY_TOKENS = 1_000_000_000;
const DUST = 10_000n; // below this a sweep costs more in network fees than it moves

export async function sweepCoin(ctx, coin, { force = false } = {}) {
  const { conn, cfg, db, log } = ctx;
  let pending = 0n;
  try { pending = await pendingFees(conn, coin.mint); } catch (e) { log?.warn?.('pending fees read failed', coin.mint, e.message); }
  let swept = 0n, sig = null;
  if (pending >= DUST && (force || pending >= BigInt(cfg.minCollectLamports))) {
    const before = BigInt(await conn.getBalance(new PublicKey(coin.vault), 'confirmed'));
    try {
      const d = await distributeInstructions(conn, coin.mint, cfg.operator.publicKey);
      sig = await sendIxs(conn, { payer: cfg.operator, ixs: d.instructions, signers: [], units: 400000, microLamports: cfg.priorityMicroLamports });
      const after = BigInt(await conn.getBalance(new PublicKey(coin.vault), 'confirmed'));
      swept = after - before;
      await db.collections.insertOne({ mint: coin.mint, key: coin.key, lamports: swept.toString(), signature: sig, graduated: d.isGraduated, at: new Date() });
      if (swept > 0n) await db.coins.updateOne({ mint: coin.mint }, { $inc: { collectedLamports: Number(swept) } });
    } catch (e) { log?.warn?.('sweep failed', coin.mint, e.message); }
  }
  return { pending, swept, sig };
}

export async function sweepAll(ctx, opts = {}) {
  const coins = await ctx.db.coins.find({ status: 'live' }).toArray();
  const out = [];
  for (const c of coins) out.push({ mint: c.mint, ...(await sweepCoin(ctx, c, opts)) });
  return out;
}

// market value, curve progress, vault balance, plus one chart point per refresh
export async function refreshCoin(ctx, coin) {
  const { conn, db, cfg } = ctx;
  const set = { updatedAt: new Date() };
  try {
    const bal = await conn.getBalance(new PublicKey(coin.vault), 'confirmed');
    set.vaultLamports = Math.max(0, bal - cfg.vaultReserveLamports);
  } catch {}
  try {
    const cs = await curveState(conn, coin.mint);
    if (cs) {
      set.graduated = !!cs.complete;
      if (!cs.complete) {
        const price = Number(cs.virtualSol) / Number(cs.virtualToken); // lamports per raw unit
        set.mcapLamports = Math.round(price * SUPPLY_TOKENS * 1e6);
        set.curveProgress = Math.min(1, Number(cs.realSol) / 85e9);
      } else {
        const pool = canonicalPumpPoolPda(new PublicKey(coin.mint));
        const baseAta = getAssociatedTokenAddressSync(new PublicKey(coin.mint), pool, true, TOKEN_2022_PROGRAM_ID);
        const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID);
        const [b, q] = await Promise.all([conn.getTokenAccountBalance(baseAta), conn.getTokenAccountBalance(quoteAta)]);
        const base = Number(b.value.amount), quote = Number(q.value.amount);
        if (base > 0) set.mcapLamports = Math.round((quote / base) * SUPPLY_TOKENS * 1e6);
        set.curveProgress = 1;
      }
    }
  } catch (e) { ctx.log?.warn?.('market read failed', coin.mint, e.message); }
  if (set.mcapLamports) {
    await db.ticks.insertOne({ mint: coin.mint, t: new Date(ctx.now()), m: set.mcapLamports });
    // 24h change from our own chart points (DexScreener replaces it when it has the coin)
    const old = await db.ticks.find({ mint: coin.mint, t: { $lte: new Date(ctx.now() - 86400000) } }).sort({ t: -1 }).limit(1).next()
      || await db.ticks.find({ mint: coin.mint }).sort({ t: 1 }).limit(1).next();
    if (old?.m) set.change24 = set.mcapLamports / old.m - 1;
  }
  await db.coins.updateOne({ mint: coin.mint }, { $set: set });
  return set;
}

export async function refreshAll(ctx) {
  const coins = await ctx.db.coins.find({ status: 'live' }).toArray();
  for (const c of coins) await refreshCoin(ctx, c);
  await marketStats(ctx, coins).catch(e => ctx.log?.warn?.('market stats', e.message));
}

// 24h volume and trades from DexScreener, 30 coins per request
export async function marketStats(ctx, coins) {
  const { cfg, db } = ctx;
  if (!cfg.marketUrl || !coins.length) return;
  for (let i = 0; i < coins.length; i += 30) {
    const chunk = coins.slice(i, i + 30).map(c => c.mint);
    const r = await fetch(`${cfg.marketUrl}/${chunk.join(',')}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) continue;
    const j = await r.json();
    const best = new Map();
    for (const p of j.pairs || []) {
      const m = p.baseToken?.address; if (!chunk.includes(m)) continue;
      if (!best.has(m) || (p.volume?.h24 || 0) > (best.get(m).volume?.h24 || 0)) best.set(m, p);
    }
    for (const [m, p] of best) {
      const set = { vol24Usd: p.volume?.h24 || 0, txns24: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0) };
      if (typeof p.priceChange?.h24 === 'number') set.change24 = p.priceChange.h24 / 100;
      await db.coins.updateOne({ mint: m }, { $set: set });
    }
  }
}
