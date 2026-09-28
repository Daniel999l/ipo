// Full local demo: a Solana validator running the real pump.fun programs, a throwaway database,
// the IPO server, and bots that take accounts public and trade. Open http://localhost:3000 and watch.
//
//   npm run sim
import { Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startValidator } from './validator.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { confirmSig, sendIxs } from '../src/tx.js';
import { buyIxs, sellIxs, ammBuyIxs, ammSellIxs, curveState } from '../src/pump.js';

const PORT = Number(process.env.PORT || 3000);
const HANDLES = ['quantmaya', 'orbitlabs', 'noahbuilds', 'lumenhq', 'tessaonchain', 'frostbyte', 'pixelmonk', 'driftwhale', 'juneprotocol', 'kaitoverse'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

const v = await startValidator({ rpcPort: 8899 });
const mongo = await MongoMemoryServer.create();
const operator = Keypair.generate();
const air = async (pk, sol) => confirmSig(v.conn, await v.conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL));
await air(operator.publicKey, 100);
const cfg = loadConfig({
  mongoUrl: mongo.getUri(), rpcUrl: v.url, operatorSecret: bs58.encode(operator.secretKey), operator, vaultMasterKey: randomBytes(32).toString('hex'),
  tokenCa: process.env.TOKEN_CA || 'iPoX4mXw2uV7cR8nHs3aJfYbE6kDt1LgWq9zpump', port: PORT, metadataMode: 'self', publicUrl: `http://localhost:${PORT}`,
  avatarUrl: process.env.AVATAR_URL || '', checkHandles: false, marketUrl: '',
  collectEveryMinutes: 0.5, refreshEveryMinutes: 0.1, minCollectLamports: 1_000_000, priorityMicroLamports: 0, schedulerTickMs: 3000, listRatePerHour: 1000,
});
const { app, startScheduler } = await createApp(cfg, { log: { info: m => console.log('[ipo]', m), warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) } });
app.listen(PORT, () => console.log(`\nIPO (local simulation) at http://localhost:${PORT}\nCtrl+C to stop.\n`));
startScheduler();

// ---- bots
const base = `http://localhost:${PORT}/api`;
async function list(handle) {
  const lister = Keypair.generate(); await air(lister.publicKey, 20);
  const prep = await (await fetch(base + '/list/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creator: lister.publicKey.toBase58(), handle }) })).json();
  if (!prep.txs) throw new Error(JSON.stringify(prep));
  const txs = prep.txs.map(t => VersionedTransaction.deserialize(Buffer.from(t, 'base64'))); txs.forEach(t => t.sign([lister]));
  const res = await (await fetch(base + '/list/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ launchId: prep.launchId, signedTxs: txs.map(t => Buffer.from(t.serialize()).toString('base64')) }) })).json();
  if (!res.mint) throw new Error(JSON.stringify(res));
  console.log(`[bot] @${handle} went public ${res.mint}`);
  return res.mint;
}

const traders = Array.from({ length: 14 }, () => Keypair.generate());
for (const t of traders) await air(t.publicKey, 400);
const mints = [];
for (const h of HANDLES.slice(0, 7)) { try { mints.push(await list(h)); } catch (e) { console.error('[bot] list failed', e.message); } }
let later = HANDLES.slice(7);

async function trade() {
  const mint = mints[Math.floor(Math.random() * mints.length)];
  const t = traders[Math.floor(Math.random() * traders.length)];
  const weight = mints.indexOf(mint) + 1; // earlier coins get more volume
  const cs = await curveState(v.conn, mint);
  const bal = BigInt((await v.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new (await import('@solana/web3.js')).PublicKey(mint), t.publicKey, false, TOKEN_2022_PROGRAM_ID)).catch(() => ({ value: { amount: '0' } }))).value.amount);
  const sellIt = bal > 0n && Math.random() < 0.3;
  if (cs.complete) {
    if (sellIt) await sendIxs(v.conn, { payer: t, ixs: await ammSellIxs(v.conn, { mint, user: t.publicKey, tokenAmount: bal / 3n, slippage: 30 }), signers: [] });
    else await sendIxs(v.conn, { payer: t, ixs: await ammBuyIxs(v.conn, { mint, user: t.publicKey, solLamports: BigInt(Math.floor(rnd(0.2, 4 / weight + 0.5) * 1e9)), slippage: 30 }), signers: [] });
  } else {
    if (sellIt) await sendIxs(v.conn, { payer: t, ixs: await sellIxs(v.conn, { mint, user: t.publicKey, tokenAmount: bal / 2n, slippage: 30 }), signers: [] });
    else await sendIxs(v.conn, { payer: t, ixs: await buyIxs(v.conn, { mint, user: t.publicKey, solLamports: BigInt(Math.floor(rnd(0.1, 6 / weight + 0.3) * 1e9)), slippage: 30 }), signers: [] });
  }
}
(async () => {
  let n = 0;
  for (;;) {
    try { await trade(); n++; if (n % 25 === 0) console.log(`[bot] ${n} trades`); } catch (e) { /* slippage etc, keep going */ }
    if (later.length && n > 0 && n % 60 === 0) { const h = later.shift(); try { mints.push(await list(h)); } catch {} }
    await sleep(rnd(300, 1500));
  }
})();
