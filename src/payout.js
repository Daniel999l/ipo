// Sends a handle's collected fees from its vault to the owner's wallet. Run by you, by hand, after checking a claim
// (see tools/payout.js). The signature is saved BEFORE sending, so running it twice can never pay twice.
import { PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { decryptKeypair } from './crypto.js';
import { buildV0, budgetIxs, confirmSig } from './tx.js';
import { sweepCoin } from './collector.js';

export async function payHandle(ctx, { key, wallet, claimId = null, log = () => {} }) {
  const { conn, cfg, db } = ctx;
  const coin = await db.coins.findOne({ key });
  if (!coin) throw new Error('No listed account @' + key);
  const to = new PublicKey(wallet);

  // an earlier payout still in flight? settle it first
  const open = await db.payouts.findOne({ key, status: 'sending' });
  if (open) {
    const st = (await conn.getSignatureStatus(open.signature, { searchTransactionHistory: true })).value;
    if (st && !st.err) { await markPaid(db, open); throw new Error(`An earlier payout already landed (${open.signature}). Run again to pay anything new.`); }
    if (!st && (await conn.getBlockHeight('confirmed')) <= open.lastValidBlockHeight) throw new Error('An earlier payout is still confirming. Wait a minute and run again.');
    await db.payouts.updateOne({ _id: open._id }, { $set: { status: 'failed' } });
  }

  await sweepCoin(ctx, coin, { force: true }); // move any waiting fees in first
  const bal = await conn.getBalance(new PublicKey(coin.vault), 'confirmed');
  const amount = bal - cfg.vaultReserveLamports;
  if (amount <= 0) throw new Error(`@${coin.handle} has nothing to pay out yet.`);

  const vault = decryptKeypair(coin.vaultKey, cfg.vaultMasterKey);
  const ixs = [...budgetIxs({ units: 20000, microLamports: cfg.priorityMicroLamports }), SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: to, lamports: amount })];
  const { tx, blockhash } = await buildV0(conn, { payer: cfg.operator.publicKey, ixs });
  tx.sign([cfg.operator, vault]);
  const signature = bs58.encode(tx.signatures[0]);
  const doc = { key, handle: coin.handle, mint: coin.mint, wallet: to.toBase58(), lamports: amount, signature, claimId, status: 'sending', lastValidBlockHeight: blockhash.lastValidBlockHeight, createdAt: new Date() };
  const { insertedId } = await db.payouts.insertOne(doc);
  const raw = tx.serialize();
  await conn.sendRawTransaction(raw, { maxRetries: 3, preflightCommitment: 'confirmed' });
  await confirmSig(conn, signature, { lastValidBlockHeight: blockhash.lastValidBlockHeight, raw });
  await markPaid(db, { ...doc, _id: insertedId });
  log(`Paid ${(amount / 1e9).toFixed(6)} SOL to ${to.toBase58()} for @${coin.handle}\nhttps://solscan.io/tx/${signature}`);
  return { signature, lamports: amount };
}

async function markPaid(db, p) {
  await db.payouts.updateOne({ _id: p._id }, { $set: { status: 'paid', paidAt: new Date() } });
  await db.coins.updateOne({ key: p.key }, { $inc: { paidLamports: p.lamports }, $set: { ownerWallet: p.wallet } });
  if (p.claimId) await db.claims.updateOne({ _id: p.claimId }, { $set: { status: 'paid', signature: p.signature } });
}
