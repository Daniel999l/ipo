// HTTP API used by the website.
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { randomUUID, randomInt } from 'crypto';
import { prepareListing, submitListing, LaunchError, lockOpts } from './launch.js';
import { prepareTrade, tokenBalance } from './trade.js';
import { parseHandle, HandleError, getAvatar, getProfile, publicProfile } from './handles.js';
import { solUsd } from './price.js';
import { verifyLock } from './pump.js';

const PUBLIC_COIN = { _id: 0, vaultKey: 0, lock: 0, split: 0 };

// chart points for many coins at once, squeezed to `points` values each
async function sparks(db, mints, sinceMs, points = 24) {
  if (!mints.length) return {};
  const since = new Date(Date.now() - sinceMs);
  const rows = await db.ticks.find({ mint: { $in: mints }, t: { $gte: since } }, { projection: { _id: 0 } }).sort({ t: 1 }).toArray();
  const by = {};
  for (const r of rows) (by[r.mint] ||= []).push(r);
  const out = {};
  for (const m of mints) {
    const a = by[m] || [];
    if (a.length <= points) { out[m] = a.map(r => r.m); continue; }
    const step = a.length / points;
    out[m] = Array.from({ length: points }, (_, i) => a[Math.min(a.length - 1, Math.floor((i + 1) * step) - 1)].m);
  }
  return out;
}

export function apiRouter(ctx) {
  const r = express.Router();
  const { db, cfg } = ctx;
  const wrap = fn => (req, res) => fn(req, res).catch(e => {
    const known = e instanceof LaunchError || e instanceof HandleError || e.status;
    const status = e.status || 500;
    if (status >= 500) ctx.log?.error?.(e);
    res.status(status).json({ error: status >= 500 && !known ? 'Something went wrong. Try again.' : e.message, ...(e.mint ? { mint: e.mint } : {}) });
  });
  const limiter = perHour => {
    const hits = new Map();
    return (req, res, next) => {
      const k = req.ip; const now = Date.now(); const arr = (hits.get(k) || []).filter(t => now - t < 3600000);
      if (arr.length >= perHour) return res.status(429).json({ error: 'Too many tries from here. Try again later.' });
      arr.push(now); hits.set(k, arr); next();
    };
  };
  const listLimit = limiter(cfg.listRatePerHour);
  const claimLimit = limiter(30);

  r.get('/config', wrap(async (req, res) => {
    const ca = await ctx.tokenCa();
    res.json({ tokenCa: ca || null, buyUrl: ca ? `https://pump.fun/coin/${ca}` : null, xHandle: cfg.xHandle, listingFeeSol: cfg.listingFeeLamports / 1e9, devBuySol: cfg.devBuyLamports / 1e9, handleSharePct: cfg.handleShareBps / 100, solUsd: await solUsd(cfg) });
  }));

  r.get('/stats', wrap(async (req, res) => {
    const [agg] = await db.coins.aggregate([{ $match: { status: 'live' } }, { $group: { _id: null, n: { $sum: 1 }, collected: { $sum: '$collectedLamports' }, vol: { $sum: '$vol24Usd' } } }]).toArray();
    const today = await db.coins.countDocuments({ status: 'live', createdAt: { $gte: new Date(Date.now() - 86400000) } });
    res.json({ listed: agg?.n || 0, listedToday: today, earnedLamports: agg?.collected || 0, vol24Usd: agg?.vol || 0, solUsd: await solUsd(cfg) });
  }));

  r.get('/coins', wrap(async (req, res) => {
    const sorts = { new: { createdAt: -1 }, top: { mcapLamports: -1, createdAt: -1 }, hot: { vol24Usd: -1, change24: -1, createdAt: -1 }, earned: { collectedLamports: -1, createdAt: -1 } };
    const sort = sorts[req.query.sort] || sorts.top;
    const q = String(req.query.q || '').replace(/^@/, '').replace(/[^\w]/g, '').slice(0, 15);
    const match = { status: 'live' };
    if (q) match.key = new RegExp('^' + q.toLowerCase());
    const coins = await db.coins.find(match, { projection: PUBLIC_COIN }).sort(sort).limit(Math.min(60, Number(req.query.limit) || 24)).toArray();
    const sp = await sparks(db, coins.map(c => c.mint), 86400000);
    res.json({ coins: coins.map(c => ({ ...c, spark: sp[c.mint] || [] })) });
  }));

  // one account: by handle or by contract address
  r.get('/coins/:id', wrap(async (req, res) => {
    const id = String(req.params.id);
    let coin = await db.coins.findOne({ mint: id }, { projection: PUBLIC_COIN });
    if (!coin) { const { key } = parseHandle(id); coin = await db.coins.findOne({ key }, { projection: PUBLIC_COIN }); }
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    if (!coin.profile && cfg.profileUrl) getProfile(ctx, coin.key, coin.handle).catch(() => {}); // fills in for next time
    const range = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[req.query.range] || 86400e3;
    const chart = (await sparks(db, [coin.mint], range, 120))[coin.mint];
    const rank = await db.coins.countDocuments({ status: 'live', mcapLamports: { $gt: coin.mcapLamports || 0 } }) + 1;
    res.json({ coin: { ...coin, rank }, chart });
  }));

  // live proof, read from the chain, that the coin's fees are locked to the account's vault
  r.get('/coins/:mint/lock', wrap(async (req, res) => {
    const coin = await db.coins.findOne({ mint: req.params.mint });
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    res.json(await verifyLock(ctx.conn, coin.mint, coin.vault, coin.split || lockOpts(cfg)));
  }));

  // is this handle listed? plus its X profile (name, bio, followers) when we can read it
  r.get('/check/:handle', wrap(async (req, res) => {
    const { handle, key } = parseHandle(req.params.handle);
    const coin = await db.coins.findOne({ key }, { projection: { mint: 1, handle: 1 } });
    const p = await getProfile(ctx, key, handle).catch(() => null);
    res.json({ handle: coin?.handle || p?.profile?.handle || handle, listed: !!coin, mint: coin?.mint || null, exists: p?.status === 'found' ? true : p?.status === 'missing' ? false : null, profile: p?.status === 'found' ? publicProfile(p.profile) : null });
  }));

  r.get('/holding', wrap(async (req, res) => {
    let w; try { w = new PublicKey(String(req.query.wallet)); } catch { return res.status(400).json({ error: 'That wallet address does not look right.' }); }
    const coin = await db.coins.findOne({ mint: String(req.query.mint) }, { projection: { mint: 1 } });
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    const [tokens, lamports] = await Promise.all([tokenBalance(ctx.conn, coin.mint, w), ctx.conn.getBalance(w, 'confirmed')]);
    res.json({ tokens: tokens.toString(), lamports });
  }));

  r.post('/list/prepare', listLimit, express.json(), wrap(async (req, res) => { res.json(await prepareListing(ctx, req.body || {})); }));
  r.post('/list/submit', express.json({ limit: '64kb' }), wrap(async (req, res) => { res.json(await submitListing(ctx, req.body || {})); }));
  r.post('/trade/prepare', express.json(), wrap(async (req, res) => { res.json(await prepareTrade(ctx, req.body || {})); }));

  // claims: the owner posts a code from the account, then you check it and pay by hand (tools/payout.js)
  r.post('/claims', claimLimit, express.json(), wrap(async (req, res) => {
    const { key } = parseHandle(req.body?.handle);
    const coin = await db.coins.findOne({ key });
    if (!coin) throw new LaunchError('This account is not public yet.', 404);
    let wallet; try { wallet = new PublicKey(String(req.body?.wallet)).toBase58(); } catch { throw new LaunchError('Paste the wallet address you want to be paid to.'); }
    const code = 'IPO-' + Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
    const claim = { _id: randomUUID(), key, handle: coin.handle, mint: coin.mint, wallet, code, status: 'waiting', createdAt: new Date() };
    await db.claims.insertOne(claim);
    res.json({ claimId: claim._id, code, handle: coin.handle, post: `Claiming my fees on IPO. ${code}` });
  }));

  r.post('/claims/:id/proof', claimLimit, express.json(), wrap(async (req, res) => {
    const c = await db.claims.findOne({ _id: String(req.params.id) });
    if (!c) throw new LaunchError('Claim not found. Start again.', 404);
    const url = String(req.body?.url || '').trim();
    const m = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!m) throw new LaunchError('Paste the link to your post.');
    if (m[1].toLowerCase() !== c.key) throw new LaunchError(`The post has to come from @${c.handle}.`);
    await db.claims.updateOne({ _id: c._id }, { $set: { status: 'review', postUrl: url, postedAt: new Date() } });
    res.json({ ok: true });
  }));

  r.get('/coins/:mint/payouts', wrap(async (req, res) => {
    const list = await db.payouts.find({ mint: req.params.mint, status: 'paid' }, { projection: { _id: 0, wallet: 1, lamports: 1, signature: 1, paidAt: 1 } }).sort({ paidAt: -1 }).limit(20).toArray();
    res.json({ payouts: list });
  }));

  return r;
}

export async function avatarRoute(ctx, req, res) {
  let p; try { p = parseHandle(req.params.handle); } catch { return res.status(404).end(); }
  const a = await getAvatar(ctx, p.key, p.handle).catch(() => null);
  if (!a || a.status !== 'found' || !a.data) return res.status(404).set('Cache-Control', 'public, max-age=3600').end();
  res.type(a.type).set('Cache-Control', 'public, max-age=86400').send(a.data.buffer ? Buffer.from(a.data.buffer) : a.data);
}
