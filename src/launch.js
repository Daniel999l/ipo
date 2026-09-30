// Taking a handle public on Pons:
//   1. start:   the handle is held for the paying wallet, and we hand back what to send (house wallet, price, a tag)
//   2. confirm: the lister's payment is checked on chain (right wallet, right amount, right tag, never used before)
//   3. launch:  the house wallet launches the coin on Pons with the handle's own vault as the creator fee recipient
// Every step is saved before it happens, so a crash or restart finishes the listing (or refunds it) on the next tick.
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { nextSeq } from './db.js';
import { parseHandle, coinLabel, handleExists, publicProfile } from './handles.js';
import { waitReceipt } from './chain.js';
import { buildLaunch, launchedFromReceipt, coinLogo, ethUsd, UserError } from './pons.js';

export { UserError as LaunchError };

const tagFor = id => ethers.keccak256(ethers.toUtf8Bytes('ipo-list:' + id));
const lc = a => String(a || '').toLowerCase();

async function releaseExpired(ctx) {
  await ctx.db.listings.updateMany({ status: 'awaiting', expiresAt: { $lt: new Date(ctx.now()) } }, { $set: { status: 'expired' }, $unset: { hold: '' } });
}

export async function startListing(ctx, { handle: input, wallet }) {
  const { db, cfg, chain } = ctx;
  if (!ethers.isAddress(wallet)) throw new UserError('Connect a wallet first.');
  const payer = lc(wallet);
  const { handle, key } = parseHandle(input);
  const listed = await db.coins.findOne({ key }, { projection: { token: 1, handle: 1 } });
  if (listed) throw Object.assign(new UserError(`@${listed.handle} is already public.`, 409), { token: listed.token });
  if (cfg.checkHandles && (await handleExists(ctx, key, handle)) === 'missing') throw new UserError(`We could not find @${handle} on X.`, 404);
  await releaseExpired(ctx);
  // the same wallet starting again gets its own listing back
  const mine = await db.listings.findOne({ hold: key, payer, status: 'awaiting' });
  const l = mine || { _id: randomUUID(), key, handle, payer, priceWei: cfg.listingFeeWei.toString(), status: 'awaiting', hold: key, createdAt: new Date(ctx.now()) };
  l.expiresAt = new Date(ctx.now() + cfg.reserveMinutes * 60000);
  if (mine) await db.listings.updateOne({ _id: l._id }, { $set: { expiresAt: l.expiresAt } });
  else {
    try { await db.listings.insertOne(l); }
    catch (e) { if (e.code === 11000) throw new UserError('Someone is taking this account public right now. Try again in a few minutes.', 409); throw e; }
  }
  return { listingId: l._id, handle, to: chain.house.address, valueWei: l.priceWei, valueEth: ethers.formatEther(l.priceWei), data: tagFor(l._id), chainId: cfg.chainId, expiresAt: l.expiresAt };
}

// check the lister's payment on chain, then launch
export async function confirmListing(ctx, { listingId, txHash }) {
  const { db, cfg, chain } = ctx;
  const l = await db.listings.findOne({ _id: String(listingId) });
  if (!l) throw new UserError('Listing not found. Start again.', 404);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) throw new UserError('That payment does not look right.');
  const hash = lc(txHash);
  if (l.payTx && l.payTx !== hash) throw new UserError('This listing is already paid.', 409);
  if (!l.payTx) {
    const rc = await waitReceipt(chain.provider, hash, 20000);
    if (!rc) throw new UserError('We could not see your payment yet. Try again in a moment.', 202);
    const tx = await chain.provider.getTransaction(hash);
    const problems = [];
    if (rc.status !== 1) problems.push('the payment failed');
    if (lc(tx.to) !== lc(chain.house.address)) problems.push('it was not sent to the listing wallet');
    if (lc(tx.from) !== l.payer) problems.push('it came from a different wallet');
    if (BigInt(tx.value) < BigInt(l.priceWei)) problems.push('the amount is too small');
    if (lc(tx.data) !== lc(tagFor(l._id))) problems.push('it is missing the listing code');
    if (problems.length) throw new UserError('That payment does not match this listing: ' + problems.join(', ') + '.');
    try {
      const upd = await db.listings.updateOne({ _id: l._id, payTx: { $exists: false } }, { $set: { payTx: hash, paidWei: BigInt(tx.value).toString(), paidAt: new Date(ctx.now()), status: 'paid' } });
      if (!upd.modifiedCount) throw new UserError('This listing is already paid.', 409);
    } catch (e) { if (e.code === 11000) throw new UserError('That payment was already used.', 409); throw e; }
    // paid after the hold ran out: take the hold back if nobody else has the handle, otherwise refund
    if (l.status === 'expired') {
      try { await db.listings.updateOne({ _id: l._id }, { $set: { hold: l.key } }); }
      catch { await db.listings.updateOne({ _id: l._id }, { $set: { status: 'refund' } }); }
    }
  }
  return processListing(ctx, l._id);
}

// moves one listing forward as far as it can go. Safe to call again at any time.
export async function processListing(ctx, id) {
  return ctx.chain.houseTx(() => step(ctx, id));
}

async function step(ctx, id) {
  const { db, cfg, chain } = ctx;
  let l = await db.listings.findOne({ _id: id });
  if (!l) throw new UserError('Listing not found.', 404);
  if (l.status === 'live' || l.status === 'refunded') return view(l);
  if (l.status === 'refund') return refund(ctx, l);
  if (!['paid', 'launching'].includes(l.status)) return view(l);

  // a launch was already sent: see how it ended before doing anything else
  if (l.launchTx) {
    const rc = await settle(ctx, l.launchTx, l.launchRaw, l.launchNonce);
    if (rc === 'pending') return view(l); // still on its way, next tick
    if (rc?.status === 1) return finalize(ctx, l, rc);
    await db.listings.updateOne({ _id: l._id }, { $unset: { launchTx: '', launchNonce: '', launchRaw: '' }, $set: { status: 'paid' } });
    l = await db.listings.findOne({ _id: id });
  }
  // somebody else's listing won the handle meanwhile
  const taken = await db.coins.findOne({ key: l.key });
  if (taken) { await db.listings.updateOne({ _id: l._id }, { $set: { status: 'refund' }, $unset: { hold: '' } }); return refund(ctx, await db.listings.findOne({ _id: id })); }

  if (!l.vaultIndex) {
    const vaultIndex = await nextSeq(db, 'vault');
    const serial = 1000 + await nextSeq(db, 'serial');
    const { name, symbol } = coinLabel(serial);
    await db.listings.updateOne({ _id: l._id }, { $set: { vaultIndex, serial, name, symbol, vault: chain.vaultWallet(vaultIndex).address } });
    l = await db.listings.findOne({ _id: id });
  }
  const logo = await coinLogo(ctx);
  const req = await buildLaunch(ctx, { name: l.name, symbol: l.symbol, logo, website: `${cfg.publicUrl}/@${l.handle}`, vault: l.vault });
  const rc = await chain.sendSigned(chain.house, req, {
    onSigned: async ({ hash, nonce, raw }) => {
      await db.listings.updateOne({ _id: l._id }, { $set: { status: 'launching', launchTx: hash, launchNonce: nonce, launchRaw: raw } });
    },
  });
  return finalize(ctx, await db.listings.findOne({ _id: id }), rc);
}

async function finalize(ctx, l, rc) {
  const { db, chain } = ctx;
  const ev = launchedFromReceipt(rc);
  if (!ev) throw new Error('launch receipt has no TokenLaunched event: ' + rc.hash);
  const info = await chain.factory.getLaunchedToken(ev.token);
  if (lc(info.creatorFeeRecipient) !== lc(l.vault)) throw new Error('launched coin has the wrong fee recipient: ' + ev.token);
  const p = await db.profiles.findOne({ _id: l.key });
  const coin = {
    handle: p?.status === 'found' ? (p.profile.handle || l.handle) : l.handle, key: l.key,
    profile: p?.status === 'found' ? publicProfile(p.profile) : null, profileAt: p?.at || null,
    token: ev.token, curve: ev.curve, vaultIndex: l.vaultIndex, vault: l.vault, lister: l.payer,
    name: l.name, symbol: l.symbol, serial: l.serial, listTx: rc.hash, payTx: l.payTx,
    status: 'live', graduated: false, createdAt: new Date(ctx.now()),
    collectedWei: '0', owedWei: '0', paidWei: '0', buybackWei: '0',
  };
  await db.coins.updateOne({ key: l.key }, { $setOnInsert: coin }, { upsert: true });
  await db.listings.updateOne({ _id: l._id }, { $set: { status: 'live', token: ev.token, liveAt: new Date(ctx.now()) }, $unset: { hold: '' } });
  // first market value right away (straight from the curve), so the new page never shows $0
  try {
    const [[qr, tr], px] = await Promise.all([chain.curveAt(ev.curve).getReserves(), ethUsd()]);
    if (tr > 0n && px) { const priceUsd = Number(qr) / Number(tr) * px; await db.coins.updateOne({ token: ev.token, mcapUsd: { $exists: false } }, { $set: { priceUsd, mcapUsd: priceUsd * 1e9, curveProgress: 0 } }); }
  } catch {}
  return { status: 'live', handle: coin.handle, token: ev.token, curve: ev.curve, listTx: rc.hash };
}

// pays the lister back (minus the transfer's own gas) when their listing can't happen
async function refund(ctx, l) {
  const { db, chain } = ctx;
  if (l.refundTx) {
    const rc = await settle(ctx, l.refundTx, l.refundRaw, l.refundNonce);
    if (rc === 'pending') return view(l);
    if (rc?.status === 1) { await db.listings.updateOne({ _id: l._id }, { $set: { status: 'refunded' }, $unset: { hold: '' } }); return view({ ...l, status: 'refunded' }); }
  }
  const fee = await chain.provider.getFeeData();
  const to = ethers.getAddress(l.payer);
  const gasLimit = (await chain.provider.estimateGas({ from: chain.house.address, to, value: 1n })) * 130n / 100n;
  const maxFeePerGas = (fee.maxFeePerGas ?? fee.gasPrice) * 2n;
  const gasCost = gasLimit * maxFeePerGas;
  const amount = BigInt(l.paidWei || '0') - gasCost;
  if (amount <= 0n) { await db.listings.updateOne({ _id: l._id }, { $set: { status: 'refunded', refundNote: 'too small to send back' } }); return view({ ...l, status: 'refunded' }); }
  const rc = await chain.sendSigned(chain.house, { to, value: amount, gasLimit, maxFeePerGas }, {
    onSigned: async ({ hash, nonce, raw }) => {
      await db.listings.updateOne({ _id: l._id }, { $set: { refundTx: hash, refundNonce: nonce, refundRaw: raw, refundWei: amount.toString() } });
    },
  });
  await db.listings.updateOne({ _id: l._id }, { $set: { status: 'refunded' }, $unset: { hold: '' } });
  return { status: 'refunded', refundTx: rc.hash };
}

// how did a transaction we signed earlier end? receipt, 'pending', or null (it never happened and its nonce is gone)
async function settle(ctx, hash, raw, nonce) {
  const { provider, house } = ctx.chain;
  const rc = await provider.getTransactionReceipt(hash);
  if (rc) return rc;
  if ((await provider.getTransactionCount(house.address, 'latest')) > nonce) return null;
  // signed but maybe never broadcast (crash): send the exact same transaction again, it can only land once
  if (raw) await provider.broadcastTransaction(raw).catch(() => {});
  const w = await waitReceipt(provider, hash, 30000);
  return w || 'pending';
}

function view(l) {
  return { status: l.status, handle: l.handle, token: l.token || null, refundTx: l.refundTx || null };
}

export async function listingStatus(ctx, id) {
  const l = await ctx.db.listings.findOne({ _id: String(id) });
  if (!l) throw new UserError('Listing not found.', 404);
  return view(l);
}

// finish (or refund) anything that was paid but not finished, e.g. after a restart
export async function recoverListings(ctx) {
  await releaseExpired(ctx);
  const open = await ctx.db.listings.find({ status: { $in: ['paid', 'launching', 'refund'] } }).toArray();
  for (const l of open) {
    try { await processListing(ctx, l._id); } catch (e) { ctx.log?.warn?.('listing', l.handle, e.shortMessage || e.message); }
  }
}
