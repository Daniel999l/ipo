// Full run against a local copy of Robinhood Chain with the real Pons contracts: `npm test` (needs anvil).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { bootStack, api, post, wallet, listViaApi, tradeViaApi } from './helpers.js';
import { recoverListings, processListing } from '../src/launch.js';
import { collectCoin } from '../src/collector.js';
import { payHandle } from '../src/payout.js';

let S;
const E = ethers.parseEther;
before(async () => { S = await bootStack(); }, { timeout: 180000 });
after(async () => { await S?.stop(); });

const coinOf = handle => S.ctx.db.coins.findOne({ key: handle.toLowerCase() });

test('config shows the token and Pons buy link', async () => {
  const { body } = await api(S.base, '/config');
  assert.equal(body.tokenCa, S.cfg.tokenCa);
  assert.equal(body.buyUrl, 'https://www.ponsfamily.com/launchpad/' + S.cfg.tokenCa);
  assert.equal(body.chainId, 4663);
  assert.equal(body.listingFeeEth, '0.002');
});

test('listing: pay, launch on Pons, vault is the fee recipient', { timeout: 240000 }, async () => {
  const w = await wallet(S);
  const houseBefore = await S.provider.getBalance(S.ctx.chain.house.address);
  const { start, res } = await listViaApi(S, w, '@SpaceBuilder');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'live');
  assert.equal(start.to, S.ctx.chain.house.address);
  const coin = await coinOf('SpaceBuilder');
  assert.ok(coin && coin.token && coin.curve);
  const info = await S.ctx.chain.factory.getLaunchedToken(coin.token);
  assert.equal(info.creatorFeeRecipient, coin.vault);
  assert.equal(info.deployer, S.ctx.chain.house.address);
  assert.equal(Number(info.creatorTaxBps), 200);
  assert.equal(coin.vault, S.ctx.chain.vaultWallet(coin.vaultIndex).address);
  const houseAfter = await S.provider.getBalance(S.ctx.chain.house.address);
  console.log('    launch cost the house', ethers.formatEther(houseBefore + E('0.002') - houseAfter), 'ETH net of the 0.002 fee (fork gas price)');
  const st = await api(S.base, '/list/' + start.listingId);
  assert.equal(st.body.status, 'live');
  assert.equal(st.body.launchRaw, undefined);
  const again = await post(S, '/list/start', { wallet: w.address, handle: 'spacebuilder' });
  assert.equal(again.status, 409);
  const page = await api(S.base, '/coins/spacebuilder');
  assert.equal(page.body.coin.ponsUrl, 'https://www.ponsfamily.com/launchpad/' + coin.token);
});

test('bad payments are rejected', { timeout: 240000 }, async () => {
  const w = await wallet(S), other = await wallet(S);
  // too little
  let r = await listViaApi(S, w, 'lowball', { valueWei: E('0.001') });
  assert.equal(r.res.status, 400); assert.match(r.res.body.error, /too small/);
  // missing tag
  const s2 = (await post(S, '/list/start', { wallet: w.address, handle: 'lowball' })).body;
  assert.equal(s2.listingId, r.start.listingId, 'same wallet gets its listing back');
  const tx = await w.sendTransaction({ to: s2.to, value: BigInt(s2.valueWei), data: '0x' }); await tx.wait();
  r = { res: await post(S, '/list/confirm', { listingId: s2.listingId, txHash: tx.hash }) };
  assert.equal(r.res.status, 400); assert.match(r.res.body.error, /listing code/);
  // someone else's wallet paying
  const tx2 = await other.sendTransaction({ to: s2.to, value: BigInt(s2.valueWei), data: s2.data }); await tx2.wait();
  r = { res: await post(S, '/list/confirm', { listingId: s2.listingId, txHash: tx2.hash }) };
  assert.equal(r.res.status, 400); assert.match(r.res.body.error, /different wallet/);
  // the handle is held for w, not other
  const held = await post(S, '/list/start', { wallet: other.address, handle: 'lowball' });
  assert.equal(held.status, 409);
  // a real payment works, then reusing it for another listing fails
  const good = await w.sendTransaction({ to: s2.to, value: BigInt(s2.valueWei), data: s2.data }); await good.wait();
  r = { res: await post(S, '/list/confirm', { listingId: s2.listingId, txHash: good.hash }) };
  assert.equal(r.res.status, 200, JSON.stringify(r.res.body));
  const s3 = (await post(S, '/list/start', { wallet: w.address, handle: 'reuseme' })).body;
  r = { res: await post(S, '/list/confirm', { listingId: s3.listingId, txHash: good.hash }) };
  assert.equal(r.res.status, 400); // wrong tag for this listing
  // unknown tx hash
  r = { res: await post(S, '/list/confirm', { listingId: s3.listingId, txHash: '0x' + '11'.repeat(32) }) };
  assert.ok([202, 400].includes(r.res.status));
});

test('handle taken meanwhile: the late payer is refunded', { timeout: 240000 }, async () => {
  const a = await wallet(S), b = await wallet(S);
  const sa = (await post(S, '/list/start', { wallet: a.address, handle: 'racecar' })).body;
  S.clock.t += 11 * 60000; // a's hold runs out
  const sb = await listViaApi(S, b, 'racecar');
  assert.equal(sb.res.body.status, 'live');
  const before = await S.provider.getBalance(a.address);
  const tx = await a.sendTransaction({ to: sa.to, value: BigInt(sa.valueWei), data: sa.data }); const rc = await tx.wait();
  const paid = BigInt(sa.valueWei) + rc.gasUsed * rc.gasPrice;
  const r = await post(S, '/list/confirm', { listingId: sa.listingId, txHash: tx.hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'refunded');
  const after = await S.provider.getBalance(a.address);
  const lost = before - after;
  assert.ok(lost < paid && lost < E('0.0002') + rc.gasUsed * rc.gasPrice, 'refund came back minus a little gas: lost ' + ethers.formatEther(lost));
  const again = await processListing(S.ctx, sa.listingId);
  assert.equal(again.status, 'refunded');
  assert.ok(await S.provider.getBalance(a.address) === after, 'never refunded twice');
});

test('crash after signing a launch: recovery finishes it once', { timeout: 240000 }, async () => {
  const w = await wallet(S);
  const s = (await post(S, '/list/start', { wallet: w.address, handle: 'crashtest' })).body;
  const tx = await w.sendTransaction({ to: s.to, value: BigInt(s.valueWei), data: s.data }); await tx.wait();
  const p = S.ctx.chain.provider;
  const real = p.broadcastTransaction.bind(p);
  let armed = true;
  p.broadcastTransaction = async raw => { if (armed) { armed = false; throw new Error('simulated crash'); } return real(raw); };
  const r = await post(S, '/list/confirm', { listingId: s.listingId, txHash: tx.hash });
  assert.equal(r.status, 500);
  p.broadcastTransaction = real;
  const l = await S.ctx.db.listings.findOne({ _id: s.listingId });
  assert.equal(l.status, 'launching'); assert.ok(l.launchTx);
  await recoverListings(S.ctx);
  const done = await S.ctx.db.listings.findOne({ _id: s.listingId });
  assert.equal(done.status, 'live');
  const coin = await coinOf('crashtest');
  assert.equal(coin.listTx, l.launchTx, 'the exact signed launch landed, no second launch');
  await recoverListings(S.ctx);
  assert.equal(await S.ctx.db.coins.countDocuments({ key: 'crashtest' }), 1);
});

test('buy and sell on the curve through the site, then collect fees 80/20', { timeout: 240000 }, async () => {
  const coin = await coinOf('SpaceBuilder');
  await S.fork.skip(10); // past the 3 second snipe tax
  const t = await wallet(S, 20);
  const b = await tradeViaApi(S, t, { token: coin.token, side: 'buy', eth: 1 });
  const bal = await S.ctx.chain.erc20(coin.token).balanceOf(t.address);
  assert.ok(bal > 0n && bal >= BigInt(b.expectTokens) * 90n / 100n);
  const h = await api(S.base, `/holding?wallet=${t.address}&token=${coin.token}`);
  assert.equal(h.body.tokens, ethers.formatEther(bal));
  // first sell needs an approve, tradeViaApi sends it then the sell
  const first = await post(S, '/trade/prepare', { wallet: t.address, token: coin.token, side: 'sell', percent: 50 });
  assert.ok(first.body.approve, 'approve is asked first');
  const ethBefore = await S.provider.getBalance(t.address);
  await tradeViaApi(S, t, { token: coin.token, side: 'sell', percent: 50 });
  assert.ok((await S.provider.getBalance(t.address)) > ethBefore);
  const bad = await post(S, '/trade/prepare', { wallet: t.address, token: coin.token, side: 'buy', eth: 999 });
  assert.equal(bad.status, 400);

  const vault = coin.vault;
  const bbBefore = await S.provider.getBalance(S.buyback);
  const out = await collectCoin(S.ctx, coin);
  assert.ok(out.claimedWei > E('0.01'), 'claimed ' + ethers.formatEther(out.claimedWei));
  const c = await coinOf('SpaceBuilder');
  const held = out.claimedWei, bb = held * 2000n / 10000n;
  assert.equal(c.collectedWei, held.toString());
  assert.equal(c.owedWei, (held - bb).toString());
  assert.equal(c.buybackWei, bb.toString());
  assert.equal((await S.provider.getBalance(S.buyback)) - bbBefore, bb);
  assert.ok((await S.provider.getBalance(vault)) >= held - bb);
  assert.equal(await S.ctx.chain.escrow.balanceOf(vault), 0n);
  const again = await collectCoin(S.ctx, c);
  assert.equal(again.claimedWei, 0n, 'nothing new to collect');
  const stats = await api(S.base, '/stats');
  assert.ok(stats.body.earnedEth > 0);
});

test('payout pays the owner once', { timeout: 240000 }, async () => {
  const owner = ethers.Wallet.createRandom().address;
  const c = await coinOf('SpaceBuilder');
  const r = await payHandle(S.ctx, { handle: 'SpaceBuilder', wallet: owner });
  assert.equal(await S.provider.getBalance(owner), r.wei);
  assert.ok(r.wei >= BigInt(c.owedWei));
  const after = await coinOf('SpaceBuilder');
  assert.equal(after.owedWei, '0');
  assert.equal(after.paidWei, r.wei.toString());
  await assert.rejects(payHandle(S.ctx, { handle: 'SpaceBuilder', wallet: owner }), /nothing to pay/);
  assert.equal(await S.provider.getBalance(owner), r.wei);
  const list = await api(S.base, '/coins/' + c.token + '/payouts');
  assert.equal(list.body.payouts.length, 1);
});

test('claims take an EVM wallet and an X post', async () => {
  const bad = await post(S, '/claims', { handle: 'SpaceBuilder', wallet: 'not-a-wallet' });
  assert.equal(bad.status, 400);
  const ok = await post(S, '/claims', { handle: 'SpaceBuilder', wallet: ethers.Wallet.createRandom().address });
  assert.equal(ok.status, 200); assert.match(ok.body.code, /^IPO-/);
  const wrong = await post(S, `/claims/${ok.body.claimId}/proof`, { url: 'https://x.com/someoneelse/status/123' });
  assert.equal(wrong.status, 400);
  const right = await post(S, `/claims/${ok.body.claimId}/proof`, { url: 'https://x.com/SpaceBuilder/status/123' });
  assert.equal(right.status, 200);
});

test('graduation: site sends traders to Pons and fees still collect', { timeout: 300000 }, async () => {
  const coin = await coinOf('racecar');
  await S.fork.skip(10);
  const whale = await wallet(S, 20);
  const cv = S.ctx.chain.curveAt(coin.curve).connect(whale);
  for (let i = 0; i < 6 && !(await cv.graduated()); i++) {
    await (await cv.buy(E('1'), 0, whale.address, { value: E('1') })).wait();
  }
  assert.equal(await cv.graduated(), true, 'coin graduated');
  const r = await post(S, '/trade/prepare', { wallet: whale.address, token: coin.token, side: 'buy', eth: 0.1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.url, 'https://www.ponsfamily.com/launchpad/' + coin.token);
  const out = await collectCoin(S.ctx, coin, { force: true });
  assert.ok(out.claimedWei > 0n, 'fees from the curve were claimed after graduation');
});

test('market refresh and pages', { timeout: 120000 }, async () => {
  await S.tick(); // scheduler tick: recovery, profiles, markets (refresh interval is long, so run it directly)
  const { refreshAll } = await import('../src/collector.js');
  await refreshAll(S.ctx);
  const list = await api(S.base, '/coins?sort=top');
  assert.ok(list.body.coins.length >= 3);
  const rc = list.body.coins.find(c => c.handle === 'racecar');
  assert.equal(rc.graduated, true); assert.equal(rc.curveProgress, 1);
  assert.ok(list.body.coins.filter(c => !c.graduated).every(c => c.mcapUsd > 0), JSON.stringify(list.body.coins.map(c => [c.handle, c.mcapUsd])));
  for (const path of ['/', '/markets', '/claim', '/@SpaceBuilder', '/vendor/ethers.js', '/nope']) {
    const res = await fetch(`http://127.0.0.1:${S.port}${path}`);
    assert.equal(res.status, path === '/nope' ? 404 : 200, path);
  }
});
