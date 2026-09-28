import { Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startValidator } from '../sim/validator.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { confirmSig, sendIxs } from '../src/tx.js';
import { buyIxs, sellIxs } from '../src/pump.js';

export async function bootStack({ port = 3999, rpcPort = 8899, overrides = {} } = {}) {
  const validator = await startValidator({ rpcPort });
  const mongo = await MongoMemoryServer.create();
  const operator = Keypair.generate();
  await airdrop(validator.conn, operator.publicKey, 50);
  const buyback = Keypair.generate(); // separate wallets so the test can see exactly what each one receives
  const treasury = Keypair.generate();
  await airdrop(validator.conn, buyback.publicKey, 1);
  await airdrop(validator.conn, treasury.publicKey, 1);
  const clock = { t: Date.now() };
  const cfg = loadConfig({
    mongoUrl: mongo.getUri(), dbName: 'ipo_test', rpcUrl: validator.url, operatorSecret: bs58.encode(operator.secretKey), operator,
    vaultMasterKey: randomBytes(32).toString('hex'), buybackWallet: buyback.publicKey.toBase58(), treasuryWallet: treasury.publicKey.toBase58(),
    tokenCa: Keypair.generate().publicKey.toBase58(), port, metadataMode: 'self', avatarUrl: '', checkHandles: false, marketUrl: '',
    publicUrl: `http://127.0.0.1:${port}`, mintSuffix: 'pt', priorityMicroLamports: 0, minCollectLamports: 1, schedulerTickMs: 1e9, ...overrides,
  });
  const quiet = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) };
  const built = await createApp(cfg, { now: () => clock.t, log: quiet });
  const server = await new Promise(r => { const s = built.app.listen(port, () => r(s)); });
  const base = `http://127.0.0.1:${port}/api`;
  const stop = async () => { server.close(); await built.stop(); await mongo.stop(); await validator.stop(); };
  return { ...built, cfg, conn: validator.conn, clock, base, stop, operator, buyback, treasury, port };
}

export async function airdrop(conn, pk, sol) { return confirmSig(conn, await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)); }

export async function api(base, path, opts = {}) {
  const r = await fetch(base + path, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const J = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const post = (stack, path, body) => api(stack.base, path, J(body));

// what the website does: prepare, sign every transaction in the wallet (signAllTransactions), submit
export async function listViaApi(stack, lister, handle) {
  const prep = await post(stack, '/list/prepare', { creator: lister.publicKey.toBase58(), handle });
  if (prep.status !== 200) throw Object.assign(new Error('prepare ' + JSON.stringify(prep.body)), { res: prep });
  const txs = prep.body.txs.map(t => VersionedTransaction.deserialize(Buffer.from(t, 'base64')));
  txs.forEach(tx => tx.sign([lister]));
  const sub = await post(stack, '/list/submit', { launchId: prep.body.launchId, signedTxs: txs.map(tx => Buffer.from(tx.serialize()).toString('base64')) });
  if (sub.status !== 200) throw new Error('submit ' + JSON.stringify(sub.body));
  return { ...sub.body, prep: prep.body };
}

// what the website does for a trade: server builds it, the wallet signs and sends it
export async function tradeViaApi(stack, wallet, body) {
  const r = await post(stack, '/trade/prepare', { wallet: wallet.publicKey.toBase58(), ...body });
  if (r.status !== 200) throw Object.assign(new Error('trade ' + JSON.stringify(r.body)), { res: r });
  const tx = VersionedTransaction.deserialize(Buffer.from(r.body.tx, 'base64'));
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await stack.conn.sendRawTransaction(raw, { preflightCommitment: 'confirmed' });
  return confirmSig(stack.conn, sig, { raw });
}

export async function buy(conn, kp, mint, sol) { return sendIxs(conn, { payer: kp, ixs: await buyIxs(conn, { mint, user: kp.publicKey, solLamports: BigInt(Math.round(sol * LAMPORTS_PER_SOL)), slippage: 20 }), signers: [] }); }
export async function sell(conn, kp, mint, amount) { return sendIxs(conn, { payer: kp, ixs: await sellIxs(conn, { mint, user: kp.publicKey, tokenAmount: amount, slippage: 20 }), signers: [] }); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
