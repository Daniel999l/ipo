import { ethers } from 'ethers';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startFork } from '../sim/anvil.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

export async function bootStack({ port = 3999, overrides = {} } = {}) {
  const fork = await startFork({ port: 8547 });
  const mongo = await MongoMemoryServer.create();
  const houseW = ethers.Wallet.createRandom();
  const buyback = ethers.Wallet.createRandom().address;
  await fork.fund(houseW.address, 1);
  const clock = { t: Date.now() };
  const cfg = loadConfig({
    mongoUrl: mongo.getUri(), dbName: 'ipo_test', rpcUrl: fork.url, housePrivateKey: houseW.privateKey, buybackWallet: buyback,
    tokenCa: ethers.Wallet.createRandom().address, port, skipImageUpload: true, checkHandles: false, profileUrl: '', avatarUrl: '',
    minSweepEth: '0.0000001', schedulerTickMs: 1e9, collectEveryMinutes: 1e6, refreshEveryMinutes: 1e6, ...overrides,
  });
  const quiet = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) };
  const built = await createApp(cfg, { now: () => clock.t, log: quiet });
  const server = await new Promise(r => { const s = built.app.listen(port, () => r(s)); });
  const base = `http://127.0.0.1:${port}/api`;
  const stop = async () => { server.close(); await built.stop(); await mongo.stop(); await fork.stop(); };
  return { ...built, cfg, fork, provider: fork.provider, clock, base, stop, buyback, port };
}

export async function api(base, path, opts = {}) {
  const r = await fetch(base + path, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const J = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const post = (S, path, body) => api(S.base, path, J(body));

// a funded test wallet (NonceManager so back-to-back sends never collide)
export async function wallet(S, eth = 10) {
  const w = ethers.Wallet.createRandom().connect(S.provider);
  await S.fork.fund(w.address, eth);
  const nm = new ethers.NonceManager(w); nm.address = w.address;
  return nm;
}

// what the website does: start, pay from the wallet, confirm
export async function listViaApi(S, w, handle, { valueWei, data } = {}) {
  const start = await post(S, '/list/start', { wallet: w.address, handle });
  if (start.status !== 200) throw Object.assign(new Error('start ' + JSON.stringify(start.body)), { res: start });
  const tx = await w.sendTransaction({ to: start.body.to, value: valueWei ?? BigInt(start.body.valueWei), data: data ?? start.body.data });
  await tx.wait();
  const conf = await post(S, '/list/confirm', { listingId: start.body.listingId, txHash: tx.hash });
  return { start: start.body, payTx: tx.hash, res: conf };
}

// what the website does for a trade: server builds it, the wallet signs and sends it
export async function tradeViaApi(S, w, body) {
  for (let i = 0; i < 2; i++) {
    const r = await post(S, '/trade/prepare', { wallet: w.address, ...body });
    if (r.status !== 200) throw Object.assign(new Error('trade ' + JSON.stringify(r.body)), { res: r });
    const t = r.body.approve || r.body.tx;
    await (await w.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) })).wait();
    if (!r.body.approve) return r.body;
  }
}
