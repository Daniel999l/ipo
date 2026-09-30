// HTTP API used by the website.
import express from 'express';
import { ethers } from 'ethers';
import { randomUUID, randomInt } from 'crypto';
import { startListing, confirmListing, listingStatus } from './launch.js';
import { prepareTrade, tokenBalance } from './trade.js';
import { parseHandle, HandleError, getAvatar, getProfile, publicProfile } from './handles.js';
import { ethUsd, UserError } from './pons.js';

const PUBLIC_COIN = { _id: 0 };

// chart points for many coins at once, squeezed to `points` values each
async function sparks(db, tokens, sinceMs, points = 24) {
  if (!tokens.length) return {};
  const rows = await db.ticks.find({ token: { $in: tokens }, t: { $gte: new Date(Date.now() - sinceMs) } }, { projection: { _id: 0 } }).sort({ t: 1 }).toArray();
  const by = {};
  for (const r of rows) (by[r.token] ||= []).push(r);
  const out = {};
  for (const m of tokens) {
    const a = by[m] || [];
    if (a.length <= points) { out[m] = a.map(r => r.m); continue; }
    const step = a.length / points;
    out[m] = Array.from({ length: points }, (_, i) => a[Math.min(a.length - 1, Math.floor((i + 1) * step) - 1)].m);
  }
  return out;
}

export function apiRouter(ctx) {
  const r = express.Router();
  const { db, cfg, chain } = ctx;
  const wrap = fn => (req, res) => fn(req, res).catch(e => {
    const known = e instanceof UserError || e instanceof HandleError;
    const status = known ? e.status : 500;
    if (status >= 500 && !known) ctx.log?.error?.(e);
    res.status(status).json({ error: known ? e.message : 'Something went wrong. Try again.', ...(e.token ? { token: e.token } : {}), ...(e.url ? { url: e.url } : {}) });
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
  const findCoin = async id => {
    const s = String(id);
    if (ethers.isAddress(s)) return db.coins.findOne({ token: ethers.getAddress(s) }, { projection: PUBLIC_COIN });
    const { key } = parseHandle(s);
    return db.coins.findOne({ key }, { projection: PUBLIC_COIN });
  };

  r.get('/config', wrap(async (req, res) => {
    const ca = await ctx.tokenCa();
    res.json({
      tokenCa: ca || null, buyUrl: ca ? cfg.ponsTokenPage + ca : null, xHandle: cfg.xHandle,
      listingFeeEth: ethers.formatEther(cfg.listingFeeWei), handleSharePct: cfg.handleShareBps / 100, creatorTaxPct: cfg.creatorTaxBps / 100,
      chainId: cfg.chainId, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorer: cfg.explorer, ponsTokenPage: cfg.ponsTokenPage, ethUsd: await ethUsd(),
    });
  }));

  r.get('/stats', wrap(async (req, res) => {
    const [agg] = await db.coins.aggregate([{ $match: { status: 'live' } }, { $group: { _id: null, n: { $sum: 1 }, earned: { $sum: '$collectedEth' }, vol: { $sum: '$vol24Usd' } } }]).toArray();
    const today = await db.coins.countDocuments({ status: 'live', createdAt: { $gte: new Date(Date.now() - 86400000) } });
    res.json({ listed: agg?.n || 0, listedToday: today, earnedEth: agg?.earned || 0, vol24Usd: agg?.vol || 0, ethUsd: await ethUsd() });
  }));

  r.get('/coins', wrap(async (req, res) => {
    const sorts = { new: { createdAt: -1 }, top: { mcapUsd: -1, createdAt: -1 }, hot: { vol24Usd: -1, change24: -1, createdAt: -1 }, earned: { collectedEth: -1, createdAt: -1 } };
    const sort = sorts[req.query.sort] || sorts.top;
    const q = String(req.query.q || '').replace(/^@/, '').replace(/[^\w]/g, '').slice(0, 15);
    const match = { status: 'live' };
    if (q) match.key = new RegExp('^' + q.toLowerCase());
    const coins = await db.coins.find(match, { projection: PUBLIC_COIN }).sort(sort).limit(Math.min(60, Number(req.query.limit) || 24)).toArray();
    const sp = await sparks(db, coins.map(c => c.token), 86400000);
    res.json({ coins: coins.map(c => ({ ...c, spark: sp[c.token] || [] })) });
  }));

  r.get('/coins/:id', wrap(async (req, res) => {
    const coin = await findCoin(req.params.id);
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    if (!coin.profile && cfg.profileUrl) getProfile(ctx, coin.key, coin.handle).catch(() => {});
    const range = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[req.query.range] || 86400e3;
    const chart = (await sparks(db, [coin.token], range, 120))[coin.token];
    const rank = await db.coins.countDocuments({ status: 'live', mcapUsd: { $gt: coin.mcapUsd || 0 } }) + 1;
    res.json({ coin: { ...coin, rank, ponsUrl: cfg.ponsTokenPage + coin.token }, chart });
  }));

  r.get('/check/:handle', wrap(async (req, res) => {
    const { handle, key } = parseHandle(req.params.handle);
    const coin = await db.coins.findOne({ key }, { projection: { token: 1, handle: 1 } });
    const p = await getProfile(ctx, key, handle).catch(() => null);
    res.json({ handle: coin?.handle || p?.profile?.handle || handle, listed: !!coin, token: coin?.token || null, exists: p?.status === 'found' ? true : p?.status === 'missing' ? false : null, profile: p?.status === 'found' ? publicProfile(p.profile) : null });
  }));

  r.get('/holding', wrap(async (req, res) => {
    if (!ethers.isAddress(String(req.query.wallet))) return res.status(400).json({ error: 'That wallet address does not look right.' });
    const coin = await findCoin(String(req.query.token));
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    const [tokens, wei] = await Promise.all([tokenBalance(ctx, coin.token, req.query.wallet), chain.provider.getBalance(String(req.query.wallet))]);
    res.json({ tokens: ethers.formatEther(tokens), eth: ethers.formatEther(wei) });
  }));

  r.post('/list/start', listLimit, express.json(), wrap(async (req, res) => { res.json(await startListing(ctx, req.body || {})); }));
  r.post('/list/confirm', express.json(), wrap(async (req, res) => { res.json(await confirmListing(ctx, req.body || {})); }));
  r.get('/list/:id', wrap(async (req, res) => { res.json(await listingStatus(ctx, req.params.id)); }));
  r.post('/trade/prepare', express.json(), wrap(async (req, res) => { res.json(await prepareTrade(ctx, req.body || {})); }));

  // claims: the owner posts a code from the account, then you check it and pay by hand (tools/payout.js)
  r.post('/claims', claimLimit, express.json(), wrap(async (req, res) => {
    const { key } = parseHandle(req.body?.handle);
    const coin = await db.coins.findOne({ key });
    if (!coin) throw new UserError('This account is not public yet.', 404);
    if (!ethers.isAddress(String(req.body?.wallet || ''))) throw new UserError('Paste the wallet address you want to be paid to.');
    const wallet = ethers.getAddress(String(req.body.wallet));
    const code = 'IPO-' + Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
    const claim = { _id: randomUUID(), key, handle: coin.handle, token: coin.token, wallet, code, status: 'waiting', createdAt: new Date() };
    await db.claims.insertOne(claim);
    res.json({ claimId: claim._id, code, handle: coin.handle, post: `Claiming my fees on IPO. ${code}` });
  }));

  r.post('/claims/:id/proof', claimLimit, express.json(), wrap(async (req, res) => {
    const c = await db.claims.findOne({ _id: String(req.params.id) });
    if (!c) throw new UserError('Claim not found. Start again.', 404);
    const url = String(req.body?.url || '').trim();
    const m = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!m) throw new UserError('Paste the link to your post.');
    if (m[1].toLowerCase() !== c.key) throw new UserError(`The post has to come from @${c.handle}.`);
    await db.claims.updateOne({ _id: c._id }, { $set: { status: 'review', postUrl: url, postedAt: new Date() } });
    res.json({ ok: true });
  }));

  r.get('/coins/:token/payouts', wrap(async (req, res) => {
    const coin = await findCoin(req.params.token);
    if (!coin) return res.status(404).json({ error: 'Not listed yet.' });
    const list = await db.payouts.find({ token: coin.token, status: 'paid' }, { projection: { _id: 1, wallet: 1, wei: 1, paidAt: 1 } }).sort({ paidAt: -1 }).limit(20).toArray();
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
