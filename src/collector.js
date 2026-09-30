// Fees: each handle's vault sweeps its curve's creator tax into the Pons fee escrow, claims it, and sends the
// buyback share on. The rest stays in the vault, owed to the account owner (tools/payout.js pays it).
// Markets: market value, 24h volume and change, graduation progress, and one chart point per refresh.
import { ethers } from 'ethers';
import { IFACE } from './chain.js';
import { ponsMarkets } from './pons.js';

const big = v => BigInt(v || '0');

// add to a wei counter stored as a string, safely even if two processes touch the same coin
export async function addWei(db, token, fields) {
  for (let i = 0; i < 20; i++) {
    const c = await db.coins.findOne({ token });
    const filter = { token }, set = {};
    for (const [f, d] of Object.entries(fields)) {
      filter[f] = c[f]; set[f] = (big(c[f]) + BigInt(d)).toString();
      set[f.replace(/Wei$/, 'Eth')] = Number(ethers.formatEther(set[f])); // number copy for sorting and display
    }
    if ((await db.coins.updateOne(filter, { $set: set })).modifiedCount) return;
  }
  throw new Error('could not update counters for ' + token);
}

export async function collectCoin(ctx, coin, { force = false } = {}) {
  const { chain, cfg, db, log } = ctx;
  const vault = chain.vaultWallet(coin.vaultIndex);
  const out = { token: coin.token, swept: false, claimedWei: 0n };
  const min = force ? 1n : cfg.minSweepWei;

  // 0. a claim or buyback that was sent right before a crash: count it now
  for (const f of await db.fees.find({ token: coin.token, status: 'pending' }).toArray()) {
    const rc = await chain.provider.getTransactionReceipt(f._id).catch(() => null);
    if (!rc) {
      if ((await chain.provider.getTransactionCount(vault.address, 'latest')) > f.nonce) await db.fees.updateOne({ _id: f._id }, { $set: { status: 'failed' } });
      continue;
    }
    if (rc.status !== 1) { await db.fees.updateOne({ _id: f._id }, { $set: { status: 'failed' } }); continue; }
    if ((await db.fees.updateOne({ _id: f._id, status: 'pending' }, { $set: { status: 'done' } })).modifiedCount) {
      const w = BigInt(f.wei);
      // after a recovered claim the buyback share simply stays in the vault, so the owner's share is what we add
      if (f.kind === 'claim') await addWei(db, coin.token, { collectedWei: w, owedWei: w * BigInt(cfg.handleShareBps) / 10000n });
      else if (f.kind === 'buyback') await addWei(db, coin.token, { buybackWei: w });
    }
  }

  // 1. sweep the curve's creator tax into the escrow (only while on the curve; Pons also does this on its own)
  try {
    const cv = chain.curveAt(coin.curve);
    const [graduated, pending] = await Promise.all([cv.graduated().catch(() => true), cv.creatorTaxBalance().catch(() => 0n)]);
    if (!graduated && pending >= min) {
      await chain.vaultCall(vault, { to: coin.curve, data: IFACE.curve.encodeFunctionData('sweepFees', [0]) });
      out.swept = true;
    }
  } catch (e) { log?.warn?.('sweep skipped', coin.handle, e.shortMessage || e.message); }

  // 2. claim what the escrow holds for this vault, 3. send the buyback share on
  const held = await chain.escrow.balanceOf(vault.address);
  if (held >= min && held > 0n) {
    const buyback = held * BigInt(10000 - cfg.handleShareBps) / 10000n;
    const owed = held - buyback;
    const doc = { token: coin.token, key: coin.key, kind: 'claim', wei: held.toString(), at: new Date(), status: 'pending' };
    const rc = await chain.vaultCall(vault, { to: cfg.ponsFeeEscrow, data: IFACE.escrow.encodeFunctionData('claim', [held]) }, { onSigned: async ({ hash, nonce }) => { doc._id = hash; doc.nonce = nonce; await db.fees.insertOne(doc); } });
    if ((await db.fees.updateOne({ _id: rc.hash, status: 'pending' }, { $set: { status: 'done' } })).modifiedCount) await addWei(db, coin.token, { collectedWei: held, owedWei: owed });
    out.claimedWei = held;
    if (buyback > 0n) {
      const to = cfg.buybackWallet || chain.house.address;
      const bdoc = { token: coin.token, key: coin.key, kind: 'buyback', wei: buyback.toString(), to, at: new Date(), status: 'pending' };
      try {
        const brc = await chain.vaultCall(vault, { to, value: buyback }, { onSigned: async ({ hash, nonce }) => { bdoc._id = hash; bdoc.nonce = nonce; await db.fees.insertOne(bdoc); } });
        if ((await db.fees.updateOne({ _id: brc.hash, status: 'pending' }, { $set: { status: 'done' } })).modifiedCount) await addWei(db, coin.token, { buybackWei: buyback });
      } catch (e) { log?.warn?.('buyback transfer failed, it stays in the vault', coin.handle, e.shortMessage || e.message); }
    }
  }
  return out;
}

export async function collectAll(ctx, opts = {}) {
  const coins = await ctx.db.coins.find({ status: 'live' }).toArray();
  const out = [];
  for (const c of coins) {
    try { out.push(await collectCoin(ctx, c, opts)); } catch (e) { ctx.log?.warn?.('collect failed', c.handle, e.shortMessage || e.message); }
  }
  return out;
}

export async function refreshAll(ctx) {
  const { db } = ctx;
  const coins = await db.coins.find({ status: 'live' }, { projection: { token: 1, curve: 1 } }).toArray();
  if (!coins.length) return;
  const m = await ponsMarkets(ctx, coins);
  const now = new Date(ctx.now());
  for (const c of coins) {
    const x = m[c.token.toLowerCase()] || {};
    const set = { updatedAt: now };
    for (const k of ['mcapUsd', 'priceUsd', 'vol24Usd', 'trades24', 'change24', 'curveProgress']) if (x[k] != null && isFinite(x[k])) set[k] = x[k];
    if (x.graduated != null) set.graduated = !!x.graduated;
    if (set.mcapUsd) await db.ticks.insertOne({ token: c.token, t: now, m: set.mcapUsd });
    // no Pons chart yet (brand new coin): 24h change from our own chart points
    if (set.change24 == null && set.mcapUsd) {
      const old = await db.ticks.find({ token: c.token, t: { $lte: new Date(ctx.now() - 86400000) } }).sort({ t: -1 }).limit(1).next()
        || await db.ticks.find({ token: c.token }).sort({ t: 1 }).limit(1).next();
      if (old?.m) set.change24 = set.mcapUsd / old.m - 1;
    }
    await db.coins.updateOne({ token: c.token }, { $set: set });
  }
}

export const weiToEth = w => Number(ethers.formatEther(big(w)));
