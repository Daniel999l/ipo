// Pays an account owner what their vault holds for them (owedWei). Run by you, by hand, after checking a claim
// (tools/payout.js). The transaction is saved before it is sent, so running it twice never pays twice.
import { ethers } from 'ethers';
import { parseHandle } from './handles.js';
import { collectCoin, addWei } from './collector.js';

export async function payHandle(ctx, { handle, wallet, claimId = null, log = () => {} }) {
  const { chain, db } = ctx;
  const { key } = parseHandle(handle);
  const coin = await db.coins.findOne({ key });
  if (!coin) throw new Error('No listed account @' + key);
  if (!ethers.isAddress(wallet)) throw new Error('That wallet address does not look right: ' + wallet);
  const to = ethers.getAddress(wallet);

  // an earlier payout still in flight? settle it first
  const open = await db.payouts.findOne({ key, status: 'sending' });
  if (open) {
    const rc = await chain.provider.getTransactionReceipt(open._id);
    if (rc?.status === 1) { await markPaid(db, coin, open); throw new Error(`An earlier payout already landed (${open._id}). Run again to pay anything new.`); }
    if (!rc && (await chain.provider.getTransactionCount(coin.vault, 'latest')) <= open.nonce) throw new Error('An earlier payout is still confirming. Wait a minute and run again.');
    await db.payouts.updateOne({ _id: open._id }, { $set: { status: 'failed' } });
  }

  await collectCoin(ctx, coin, { force: true }); // claim anything waiting first
  const fresh = await db.coins.findOne({ key });
  const owed = BigInt(fresh.owedWei || '0');
  if (owed <= 0n) throw new Error(`@${coin.handle} has nothing to pay out yet.`);
  const vault = chain.vaultWallet(coin.vaultIndex);
  let doc;
  const rc = await chain.vaultCall(vault, { to, value: owed }, {
    onSigned: async ({ hash, raw }) => {
      doc = { _id: hash, key, handle: coin.handle, token: coin.token, wallet: to, wei: owed.toString(), claimId, status: 'sending', nonce: ethers.Transaction.from(raw).nonce, createdAt: new Date() };
      await db.payouts.insertOne(doc);
    },
  });
  await markPaid(db, coin, doc);
  log(`Paid ${ethers.formatEther(owed)} ETH to ${to} for @${coin.handle}\n${ctx.cfg.explorer}/tx/${rc.hash}`);
  return { hash: rc.hash, wei: owed };
}

async function markPaid(db, coin, p) {
  const upd = await db.payouts.updateOne({ _id: p._id, status: { $ne: 'paid' } }, { $set: { status: 'paid', paidAt: new Date() } });
  if (!upd.modifiedCount) return;
  await addWei(db, coin.token, { owedWei: -BigInt(p.wei), paidWei: BigInt(p.wei) });
  await db.coins.updateOne({ token: coin.token }, { $set: { ownerWallet: p.wallet } });
  if (p.claimId) await db.claims.updateOne({ _id: p.claimId }, { $set: { status: 'paid', signature: p._id } });
}
