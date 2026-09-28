// End-to-end test against a local Solana validator running the REAL pump.fun programs
// (bonding curve, PumpSwap AMM, fee sharing) copied from mainnet. Nothing is mocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { bootStack, airdrop, api, post, listViaApi, tradeViaApi, buy, sleep } from './helpers.js';
import { sendIxs, sendSigned } from '../src/tx.js';
import { migrateIxs, curveState, pendingFees } from '../src/pump.js';
import { sweepAll, refreshAll } from '../src/collector.js';
import { recoverListings } from '../src/launch.js';
import { payHandle } from '../src/payout.js';
import { tokenBalance } from '../src/trade.js';
import http from 'node:http';

let S; // the running stack
const W = {}; // wallets
let A; // first listing
const bal = pk => S.conn.getBalance(pk instanceof PublicKey ? pk : new PublicKey(pk), 'confirmed');

before(async () => {
  S = await bootStack();
  for (const k of ['lister', 'lister2', 'lister3', 'alice', 'bob', 'owner', 'grad', 'amm']) { W[k] = Keypair.generate(); await airdrop(S.conn, W[k].publicKey, k === 'grad' ? 200 : 60); }
});
after(async () => { await S?.stop(); });

test('list: one transaction pays the fee, creates the coin and locks fees 80% to the handle vault, 20% to buybacks', async () => {
  const treasuryBefore = await bal(S.treasury.publicKey);
  const listerBefore = await bal(W.lister.publicKey);
  A = await listViaApi(S, W.lister, '@Quant_Maya');
  assert.equal(A.handle, 'Quant_Maya');
  assert.equal(await bal(S.treasury.publicKey) - treasuryBefore, S.cfg.listingFeeLamports, 'treasury got exactly the listing fee');
  const lock = (await api(S.base, `/coins/${A.mint}/lock`)).body;
  assert.equal(lock.ok, true);
  assert.equal(lock.adminRevoked, true);
  assert.deepEqual(lock.shareholders, [{ address: A.vault, bps: 8000, role: 'handle' }, { address: S.buyback.publicKey.toBase58(), bps: 2000, role: 'buyback' }]);
  assert.ok((await tokenBalance(S.conn, A.mint, W.lister.publicKey)) > 0n, 'tiny first buy landed');
  assert.ok(A.mint.endsWith('pt'), 'custom address ending: ' + A.mint);
  const cs = await curveState(S.conn, A.mint);
  assert.equal(cs.complete, false);
  const spent = (listerBefore - await bal(W.lister.publicKey)) / 1e9;
  console.log(`listing cost the lister ${spent.toFixed(5)} SOL in total (fee ${S.cfg.listingFeeSol} + network, rent and first buy)`);
  const coin = (await api(S.base, '/coins/quant_maya')).body.coin;
  assert.equal(coin.handle, 'Quant_Maya');
  assert.ok(!('vaultKey' in coin), 'vault keys never leave the server');
  assert.match(coin.name, /^[a-z]{6} \d{4}$/, 'plain on-chain name: ' + coin.name);
  assert.equal((await api(S.base, '/check/QUANT_MAYA')).body.listed, true);
  assert.equal((await api(S.base, '/check/nobody_here')).body.listed, false);
});

test('list: a handle can only go public once, in any letter case, and is held while someone signs', async () => {
  const dup = await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'quant_maya' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.mint, A.mint);
  // lister2 starts listing @orbitlabs; while it is signing, nobody else can take it
  const p1 = await post(S, '/list/prepare', { creator: W.lister2.publicKey.toBase58(), handle: 'orbitlabs' });
  assert.equal(p1.status, 200);
  const p2 = await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'OrbitLabs' });
  assert.equal(p2.status, 409);
  assert.match(p2.body.error, /right now/);
  // the same wallet can start again (replaces its own hold)
  const p3 = await post(S, '/list/prepare', { creator: W.lister2.publicKey.toBase58(), handle: 'orbitlabs' });
  assert.equal(p3.status, 200);
  const bad = await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'not a handle!' });
  assert.equal(bad.status, 400);
});

test('list: a changed or unsigned transaction is refused', async () => {
  const prep = (await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'bad_actor' })).body;
  const other = (await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'bad_actor2' })).body;
  const txs = other.txs.map(t => { const x = VersionedTransaction.deserialize(Buffer.from(t, 'base64')); x.sign([W.alice]); return Buffer.from(x.serialize()).toString('base64'); });
  const r = await post(S, '/list/submit', { launchId: prep.launchId, signedTxs: txs });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /changed/);
  const r2 = await post(S, '/list/submit', { launchId: prep.launchId, signedTxs: prep.txs });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /signature/);
});

test('recovery: a listing that landed while the server was down is finished on the next tick', async () => {
  const prep = (await post(S, '/list/prepare', { creator: W.lister3.publicKey.toBase58(), handle: 'noahbuilds' })).body;
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.txs[0], 'base64')); tx.sign([W.lister3]);
  // the wallet sends it itself and the server never hears back
  const sig = await sendSigned(S.conn, tx, null);
  await S.ctx.db.launches.updateOne({ _id: prep.launchId }, { $set: { submitting: true, sig, submittedAt: new Date(Date.now() - 60000) } });
  assert.equal((await api(S.base, '/check/noahbuilds')).body.listed, false);
  await recoverListings(S.ctx);
  assert.equal((await api(S.base, '/check/noahbuilds')).body.listed, true);
  assert.equal((await S.ctx.db.coins.findOne({ key: 'noahbuilds' })).mint, prep.mint);
});

test('trade: the site builds buys and sells, the wallet signs them', async () => {
  await tradeViaApi(S, W.alice, { mint: A.mint, side: 'buy', sol: 3 });
  await tradeViaApi(S, W.bob, { mint: A.mint, side: 'buy', sol: 2 });
  const got = await tokenBalance(S.conn, A.mint, W.alice.publicKey);
  assert.ok(got > 0n, 'alice holds tokens');
  await tradeViaApi(S, W.alice, { mint: A.mint, side: 'sell', percent: 50 });
  const left = await tokenBalance(S.conn, A.mint, W.alice.publicKey);
  assert.ok(left > 0n && left < got, 'sold half');
  const none = await post(S, '/trade/prepare', { wallet: W.owner.publicKey.toBase58(), mint: A.mint, side: 'sell', percent: 100 });
  assert.equal(none.status, 400);
  const h = (await api(S.base, `/holding?wallet=${W.alice.publicKey.toBase58()}&mint=${A.mint}`)).body;
  assert.equal(h.tokens, left.toString());
});

test('fees: trades create fees and sweeps move them 4 to 1 into the handle vault and the buyback wallet', async () => {
  const pend = await pendingFees(S.conn, A.mint);
  assert.ok(pend > 0n, 'fees waiting');
  const vb = await bal(A.vault), bb = await bal(S.buyback.publicKey);
  await sweepAll(S.ctx, { force: true });
  const vGot = await bal(A.vault) - vb, bGot = await bal(S.buyback.publicKey) - bb;
  console.log('split check: pending', pend.toString(), 'vault +', vGot, 'buyback +', bGot);
  assert.ok(vGot > 0 && bGot > 0);
  assert.ok(Math.abs(vGot - 4 * bGot) <= 4, 'exactly 80/20');
  await refreshAll(S.ctx);
  const c = (await api(S.base, '/coins/Quant_Maya')).body;
  assert.ok(c.coin.mcapLamports > 0, 'market value read from the curve');
  assert.equal(c.coin.vaultLamports, vGot, 'waiting for the owner');
  assert.equal(c.coin.collectedLamports, vGot);
  assert.ok(c.chart.length >= 1, 'chart point saved');
  const list = (await api(S.base, '/coins?sort=top')).body.coins;
  assert.equal(list[0].handle, 'Quant_Maya', 'most valuable first');
  assert.ok(Array.isArray(list[0].spark));
  const stats = (await api(S.base, '/stats')).body;
  assert.equal(stats.listed, 2);
  assert.equal(stats.earnedLamports, vGot);
});

test('claim + payout: the owner proves the account and gets the vault, never twice', async () => {
  const start = (await post(S, '/claims', { handle: 'quant_maya', wallet: W.owner.publicKey.toBase58() })).body;
  assert.match(start.code, /^IPO-[A-Z2-9]{6}$/);
  const wrong = await post(S, `/claims/${start.claimId}/proof`, { url: 'https://x.com/someone_else/status/123' });
  assert.equal(wrong.status, 400);
  const ok = await post(S, `/claims/${start.claimId}/proof`, { url: 'https://x.com/Quant_Maya/status/1234567890' });
  assert.equal(ok.status, 200);
  const coin = await S.ctx.db.coins.findOne({ key: 'quant_maya' });
  const vaultBal = await bal(coin.vault);
  const ob = await bal(W.owner.publicKey);
  const r = await payHandle(S.ctx, { key: 'quant_maya', wallet: W.owner.publicKey.toBase58(), claimId: start.claimId });
  assert.equal(await bal(W.owner.publicKey) - ob, vaultBal - S.cfg.vaultReserveLamports, 'owner got everything above the reserve');
  assert.equal(r.lamports, vaultBal - S.cfg.vaultReserveLamports);
  await assert.rejects(payHandle(S.ctx, { key: 'quant_maya', wallet: W.owner.publicKey.toBase58() }), /nothing to pay/);
  assert.equal((await S.ctx.db.claims.findOne({ _id: start.claimId })).status, 'paid');
  const payouts = (await api(S.base, `/coins/${A.mint}/payouts`)).body.payouts;
  assert.equal(payouts.length, 1);
});

test('graduation: after the coin moves to PumpSwap, the site still trades it and fees still reach the vault', async () => {
  await buy(S.conn, W.grad, A.mint, 150);
  assert.equal((await curveState(S.conn, A.mint)).complete, true);
  await sendIxs(S.conn, { payer: W.grad, ixs: await migrateIxs(S.conn, { mint: A.mint, user: W.grad.publicKey }), signers: [], units: 800000 });
  const before = await tokenBalance(S.conn, A.mint, W.amm.publicKey);
  await tradeViaApi(S, W.amm, { mint: A.mint, side: 'buy', sol: 5 });
  assert.ok(await tokenBalance(S.conn, A.mint, W.amm.publicKey) > before, 'bought on PumpSwap through the site');
  await tradeViaApi(S, W.amm, { mint: A.mint, side: 'sell', percent: 30 });
  assert.ok((await pendingFees(S.conn, A.mint)) > 0n);
  const vb = await bal(A.vault);
  await sweepAll(S.ctx, { force: true });
  assert.ok(await bal(A.vault) > vb, 'graduated coin fees swept into the vault');
  await refreshAll(S.ctx);
  const c = await S.ctx.db.coins.findOne({ key: 'quant_maya' });
  assert.equal(c.graduated, true);
  assert.ok(c.mcapLamports > 0, 'market value read from the PumpSwap pool');
});

test('profiles: real X name, bio and followers are shown, and handles that do not exist are refused', async () => {
  // stand-in for api.fxtwitter.com: known handles return a profile, unknown ones redirect away (what the real one does)
  const srv = http.createServer((req, res) => {
    if (req.url === '/realguy') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ code: 200, user: { screen_name: 'RealGuy', name: 'Real Guy', description: 'building things', followers: 184000, following: 12, tweets: 900, verification: { verified: true }, avatar_url: 'https://pbs.twimg.com/x_normal.jpg', joined: 'Tue Mar 21 20:50:14 +0000 2006' } })); }
    res.statusCode = 302; res.setHeader('location', 'https://example.com'); res.end();
  });
  await new Promise(r => srv.listen(4555, r));
  const keep = { profileUrl: S.cfg.profileUrl, checkHandles: S.cfg.checkHandles };
  Object.assign(S.cfg, { profileUrl: 'http://127.0.0.1:4555', checkHandles: true });
  try {
    const chk = (await api(S.base, '/check/realguy')).body;
    assert.equal(chk.exists, true);
    assert.equal(chk.handle, 'RealGuy', 'real letter case from X');
    assert.deepEqual([chk.profile.name, chk.profile.followers, chk.profile.verified, chk.profile.bio], ['Real Guy', 184000, true, 'building things']);
    const ghost = await post(S, '/list/prepare', { creator: W.alice.publicKey.toBase58(), handle: 'ghost_account' });
    assert.equal(ghost.status, 404);
    assert.match(ghost.body.error, /could not find/);
    assert.equal((await api(S.base, '/check/ghost_account')).body.exists, false);
    await listViaApi(S, W.alice, 'realguy');
    const coin = (await api(S.base, '/coins/realguy')).body.coin;
    assert.equal(coin.handle, 'RealGuy');
    assert.equal(coin.profile.name, 'Real Guy');
    assert.equal(coin.profile.followers, 184000);
  } finally { Object.assign(S.cfg, keep); srv.close(); }
});

test('site pages load', async () => {
  const origin = `http://127.0.0.1:${S.port}`;
  for (const p of ['/', '/markets', '/claim', '/@Quant_Maya', '/@somebody_new']) {
    const r = await fetch(origin + p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await fetch(origin + '/nope/nothing')).status, 404);
});
