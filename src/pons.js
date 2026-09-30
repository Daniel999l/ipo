// Everything that talks to Pons: logo upload, the launch itself, and market data.
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { IFACE } from './chain.js';
import { getSetting, setSetting } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
export class UserError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

// ---------- logo (uploaded once to Pons' IPFS, then reused for every listing)
export async function uploadImage(cfg, buf, type = 'image/png') {
  if (cfg.skipImageUpload) return 'ipfs://bafkreihybh3uowlrbxn7tmfso64izsx5uqqpxkkz4pgp6bvuexog6ztioy';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type }), 'logo.' + type.split('/')[1]);
  const r = await fetch(cfg.ponsImageUpload, { method: 'POST', body: fd, headers: { origin: 'https://www.ponsfamily.com', referer: 'https://www.ponsfamily.com/launchpad/create', 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !/^ipfs:\/\/[A-Za-z0-9]+$/.test(j.uri || '')) throw new Error('image upload failed: ' + (j.error || r.status));
  return j.uri;
}
export async function coinLogo(ctx) {
  const saved = await getSetting(ctx.db, 'coinLogo');
  if (saved) return saved;
  const p = isAbsolute(ctx.cfg.coinImage) ? ctx.cfg.coinImage : join(ROOT, ctx.cfg.coinImage);
  const uri = await uploadImage(ctx.cfg, readFileSync(p), 'image/png');
  await setSetting(ctx.db, 'coinLogo', uri);
  return uri;
}

// ---------- launch (the house wallet launches; the handle's vault gets the creator fees)
export async function buildLaunch(ctx, { name, symbol, logo, website, vault }) {
  const { factory, house } = ctx.chain;
  const [enabled, fee, econ] = await Promise.all([factory.launchEnabled(), factory.launchFee(), factory.previewLaunchEconomics(0, ethers.ZeroAddress)]);
  if (!enabled) throw new UserError('Pons launches are paused right now. Your payment is safe and the listing will finish when they reopen.', 503);
  const params = {
    name, symbol, logo, description: '',
    socials: { twitter: '', telegram: '', discord: '', website: website || '', farcaster: '' },
    creatorFeeRecipient: vault, creatorTaxBps: ctx.cfg.creatorTaxBps, buybackEnabled: false,
    expectedEconomics: econ, salt: ethers.hexlify(ethers.randomBytes(32)),
  };
  const args = [params, 0, ethers.ZeroAddress, []];
  await factory.launchToken.staticCall(...args, { value: fee, from: house.address }); // dry run: a failing launch never spends gas
  return { to: ctx.cfg.ponsFactory, data: IFACE.factory.encodeFunctionData('launchToken', args), value: fee };
}

export function launchedFromReceipt(rc) {
  for (const l of rc.logs) {
    try { const ev = IFACE.factory.parseLog(l); if (ev?.name === 'TokenLaunched') return { token: ev.args.token, curve: ev.args.curve }; } catch {}
  }
  return null;
}

// ---------- market data: price and market cap from Pons, 24h volume/change from the Pons chart, progress from the curve
export async function ponsMarkets(ctx, coins) {
  const out = {};
  const { cfg } = ctx;
  for (let i = 0; i < coins.length; i += 30) {
    const chunk = coins.slice(i, i + 30);
    const qs = chunk.map(c => 'market=' + c.token.toLowerCase() + '%2C' + ethers.ZeroAddress).join('&');
    try {
      const r = await fetch(`${cfg.ponsApi}/pons-launches/live-markets?${qs}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      const arr = r.ok ? await r.json() : [];
      for (const m of Array.isArray(arr) ? arr : []) out[String(m.token).toLowerCase()] = { mcapUsd: Number(m.marketCapUsd) || 0, priceUsd: Number(m.priceUsd) || 0, graduated: m.graduated === true };
    } catch {}
  }
  await Promise.all(coins.map(async c => {
    const k = c.token.toLowerCase();
    const o = (out[k] = out[k] || {});
    try {
      const r = await fetch(`${cfg.ponsApi}/pons-v2-market/${c.token}/chart?range=1d`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      const chart = r.ok ? await r.json() : null;
      const pts = Array.isArray(chart?.points) ? chart.points : [];
      if (pts.length) {
        o.vol24Usd = pts.reduce((s, p) => s + (Number(p.volumeQuote) || 0), 0) * (Number(chart.quoteUsd) || 0);
        o.trades24 = pts.reduce((s, p) => s + (Number(p.tradeCount) || 0), 0);
        const first = Number(pts[0].price), last = Number(pts[pts.length - 1].price);
        if (pts.length > 1 && first > 0) o.change24 = last / first - 1;
      }
    } catch {}
    try {
      const cv = ctx.chain.curveAt(c.curve);
      const [q, t, g] = await Promise.all([cv.trackedQuote(), cv.graduationThreshold(), cv.graduated()]);
      o.curveProgress = g ? 1 : t > 0n ? Math.min(1, Number(q * 10000n / t) / 10000) : 0;
      o.graduated = o.graduated || g;
      // still on the curve: the curve itself is the exact price (1B supply, 18 decimals). After graduation Pons' number is used.
      if (!g) {
        const [qr, tr] = await cv.getReserves();
        const px = await ethUsd();
        if (tr > 0n && px) { o.priceUsd = Number(qr) / Number(tr) * px; o.mcapUsd = o.priceUsd * 1e9; }
      }
    } catch {}
  }));
  return out;
}

let ethPx = { at: 0, v: 0 };
export async function ethUsd() {
  if (Date.now() - ethPx.at < 300000 && ethPx.v) return ethPx.v;
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(8000) });
    const v = Number((await r.json()).data.amount) || 0;
    if (v) ethPx = { at: Date.now(), v };
  } catch { ethPx.at = Date.now(); }
  return ethPx.v || null;
}
