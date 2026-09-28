// Taking a handle public. We build ONE transaction that the lister signs:
//   pay the listing fee + fund the handle's vault + create the coin on pump.fun + lock its creator fees
//   (HANDLE_SHARE_BPS to the handle vault, the rest to the buyback wallet, admin revoked so nobody can change it).
// Everything lands together or nothing does. A tiny first buy follows as a second transaction in the same wallet prompt.
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { randomUUID } from 'crypto';
import sdk from './pumpsdk.js';
import { launchInstructions, verifyLock, feeSharingConfigPda, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, OnlinePumpSdk, PUMP_SDK } from './pump.js';
import { buildV0, budgetIxs, sendSigned } from './tx.js';
import { encryptSecret } from './crypto.js';
import { parseHandle, coinLabel, handleExists, getProfile, publicProfile } from './handles.js';
import { uploadCoinMetadata } from './metadata.js';

const { newBondingCurve, getBuyTokenAmountFromSolAmount } = sdk;

export class LaunchError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export const lockOpts = cfg => ({ buyback: cfg.buyback, potBps: cfg.handleShareBps });

async function nextSerial(db) {
  const r = await db.settings.findOneAndUpdate({ _id: 'serial' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
  const doc = r && r.value !== undefined && r._id === undefined ? r.value : r;
  return 1000 + (doc?.value || 1);
}

// Holds the handle for this wallet while it signs, so two people can't list the same handle at once.
async function reserve(ctx, { key, creator, launchId }) {
  const { db, cfg } = ctx;
  const now = new Date(ctx.now());
  await db.launches.deleteMany({ key, submitting: { $ne: true }, $or: [{ expiresAt: { $lt: now } }, { creator }] });
  try {
    await db.launches.insertOne({ _id: launchId, key, creator, createdAt: now, expiresAt: new Date(ctx.now() + cfg.reserveSeconds * 1000) });
  } catch (e) {
    if (e.code === 11000) throw new LaunchError('Someone is taking this account public right now. Try again in a minute.', 409);
    throw e;
  }
}

export async function prepareListing(ctx, { creator, handle: input }) {
  const { conn, cfg, db, lut } = ctx;
  let creatorPk;
  try { creatorPk = new PublicKey(creator); } catch { throw new LaunchError('Connect a wallet first.'); }
  const { handle, key } = parseHandle(input);
  const listed = await db.coins.findOne({ key }, { projection: { mint: 1, handle: 1 } });
  if (listed) throw Object.assign(new LaunchError(`@${listed.handle} is already public.`, 409), { mint: listed.mint });
  if (cfg.checkHandles && (await handleExists(ctx, key, handle)) === 'missing') throw new LaunchError(`We could not find @${handle} on X.`, 404);

  const launchId = randomUUID();
  await reserve(ctx, { key, creator: creatorPk.toBase58(), launchId });
  try {
    const serial = await nextSerial(db);
    const { name, symbol } = coinLabel(serial);
    const meta = await uploadCoinMetadata(ctx, { name, symbol, website: cfg.publicUrl ? `${cfg.publicUrl}/@${handle}` : undefined });

    const mint = ctx.vanity ? await ctx.vanity.take() : Keypair.generate();
    const vault = Keypair.generate();
    // tx 1: listing fee + fund vault + create coin + lock fees (atomic)
    const ixs = [...budgetIxs({ units: 450000, microLamports: cfg.priorityMicroLamports })];
    if (cfg.listingFeeLamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: creatorPk, toPubkey: cfg.treasury, lamports: cfg.listingFeeLamports }));
    ixs.push(SystemProgram.transfer({ fromPubkey: creatorPk, toPubkey: vault.publicKey, lamports: cfg.vaultReserveLamports }));
    ixs.push(...await launchInstructions({ mint: mint.publicKey, creator: creatorPk, pot: vault.publicKey, name, symbol, uri: meta.uri, ...lockOpts(cfg) }));
    const { tx, blockhash } = await buildV0(conn, { payer: creatorPk, ixs, luts: lut ? [lut] : [] });
    tx.sign([mint]);
    if (tx.serialize().length > 1232) throw new LaunchError('Listing transaction too large', 500);
    const txs = [tx];
    // tx 2: tiny first buy so the market has a trade from the start
    if (cfg.devBuyLamports > 0) {
      const buy = [...budgetIxs({ units: 250000, microLamports: cfg.priorityMicroLamports }), ...await devBuyIxs(conn, { mint: mint.publicKey, user: creatorPk, lamports: BigInt(cfg.devBuyLamports) })];
      txs.push((await buildV0(conn, { payer: creatorPk, ixs: buy, luts: lut ? [lut] : [], blockhash })).tx);
    }

    await db.launches.updateOne({ _id: launchId }, { $set: {
      handle, mint: mint.publicKey.toBase58(), vault: vault.publicKey.toBase58(), vaultKey: encryptSecret(vault.secretKey, cfg.vaultMasterKey),
      messages: txs.map(t => Buffer.from(t.message.serialize()).toString('base64')), lastValidBlockHeight: blockhash.lastValidBlockHeight, blockhash: blockhash.blockhash,
      meta: { name, symbol, uri: meta.uri, image: meta.image, serial },
    } });
    return {
      launchId, handle, mint: mint.publicKey.toBase58(), vault: vault.publicKey.toBase58(),
      feeSol: cfg.listingFeeLamports / 1e9, txs: txs.map(t => Buffer.from(t.serialize()).toString('base64')),
    };
  } catch (e) {
    await db.launches.deleteOne({ _id: launchId }).catch(() => {});
    throw e;
  }
}

// The lister sends back the transactions with their signature. We only accept the exact transactions we built.
export async function submitListing(ctx, { launchId, signedTxs }) {
  const { conn, db } = ctx;
  const l = await db.launches.findOne({ _id: String(launchId) });
  if (!l || !l.messages) throw new LaunchError('This listing expired. Start again.', 404);
  const raw = Array.isArray(signedTxs) ? signedTxs : [];
  if (raw.length !== l.messages.length) throw new LaunchError('Sign every transaction of the listing.');
  const txs = raw.map(r => { try { return VersionedTransaction.deserialize(Buffer.from(String(r), 'base64')); } catch { throw new LaunchError('Could not read the signed transaction.'); } });
  txs.forEach((tx, i) => {
    if (Buffer.from(tx.message.serialize()).toString('base64') !== l.messages[i]) throw new LaunchError('Transaction was changed after it was prepared.');
    if (tx.message.staticAccountKeys[0].toBase58() !== l.creator || !tx.signatures.every(s => s.some(b => b !== 0))) throw new LaunchError('Wallet signature missing.');
  });
  // in flight: keep the handle held and remember the signature, so a restart can finish the listing
  const sig1 = (await import('bs58')).default.encode(txs[0].signatures[0]);
  const claim = await db.launches.updateOne({ _id: l._id, submitting: { $ne: true } }, { $set: { submitting: true, sig: sig1, submittedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) } });
  if (!claim.modifiedCount) throw new LaunchError('This listing is already being sent.', 409);
  let sig;
  try { sig = await sendSigned(conn, txs[0], { lastValidBlockHeight: l.lastValidBlockHeight }); }
  catch (e) {
    const st = await conn.getSignatureStatus(sig1, { searchTransactionHistory: true }).catch(() => null);
    if (!st?.value || st.value.err) { await db.launches.deleteOne({ _id: l._id }); throw new LaunchError(humanChainError(e), 400); }
    sig = sig1; // it landed after all
  }
  const out = await finalizeListing(ctx, l, sig);
  if (txs[1]) {
    try { out.devBuySignature = await sendSigned(conn, txs[1], { lastValidBlockHeight: l.lastValidBlockHeight }); }
    catch (e) { out.devBuyError = humanChainError(e); }
  }
  return out;
}

export async function finalizeListing(ctx, l, sig) {
  const { conn, db, cfg } = ctx;
  const lock = await verifyLock(conn, l.mint, l.vault, lockOpts(cfg));
  if (!lock.ok) throw new LaunchError('The coin was created but its fees are not locked to the account, so it will not be listed.', 409);
  const coin = {
    handle: l.handle, key: l.key, profile: null, mint: l.mint, vault: l.vault, vaultKey: l.vaultKey, lister: l.creator, ...l.meta,
    status: 'live', graduated: false, listSig: sig, createdAt: new Date(ctx.now()),
    vaultLamports: 0, collectedLamports: 0, paidLamports: 0,
    lock: { sharingConfig: lock.sharingConfig, adminRevoked: lock.adminRevoked, checkedAt: new Date() },
    split: { buyback: new PublicKey(cfg.buyback).toBase58(), potBps: cfg.handleShareBps },
  };
  const p = await db.profiles.findOne({ _id: l.key });
  if (p?.status === 'found') { coin.profile = publicProfile(p.profile); coin.handle = p.profile.handle || l.handle; coin.profileAt = p.at; }
  await db.coins.updateOne({ key: l.key }, { $setOnInsert: coin }, { upsert: true });
  await db.launches.deleteOne({ _id: l._id });
  return { handle: l.handle, mint: l.mint, vault: l.vault, signature: sig };
}

// Listings that were sent but not finished (server restart, lost connection): finish or release them.
export async function recoverListings(ctx) {
  const { db, conn } = ctx;
  const stuck = await db.launches.find({ submitting: true, submittedAt: { $lt: new Date(Date.now() - 30000) } }).toArray();
  for (const l of stuck) {
    try {
      const st = (await conn.getSignatureStatus(l.sig, { searchTransactionHistory: true })).value;
      if (st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus)) await finalizeListing(ctx, l, l.sig);
      else if (st?.err || (await conn.getBlockHeight('confirmed')) > l.lastValidBlockHeight) await db.launches.deleteOne({ _id: l._id });
    } catch (e) { ctx.log?.warn?.('recover listing', l.handle, e.message); }
  }
}

// First buy, placed after the fee lock, so the curve creator is already the fee-sharing config.
export async function devBuyIxs(conn, { mint, user, lamports }) {
  const online = new OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  const quoteAmount = new BN(lamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount });
  const curve = { ...newBondingCurve(global), creator: feeSharingConfigPda(mint), quoteMint: NATIVE_MINT, isMayhemMode: false };
  return PUMP_SDK.buyV2Instructions({ global, bondingCurveAccountInfo: null, bondingCurve: curve, associatedUserAccountInfo: null, mint, user, amount, quoteAmount, slippage: 2, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID });
}

export function humanChainError(e) {
  const m = String(e?.message || e);
  if (/insufficient (funds|lamports)|0x1\b|Attempt to debit an account/i.test(m)) return 'Not enough SOL in your wallet.';
  if (/expired|block height exceeded/i.test(m)) return 'It took too long to confirm. Try again.';
  if (/slippage|TooMuchSolRequired|TooLittleSolReceived|0x1772|0x1773|ExceededSlippage/i.test(m)) return 'The price moved too much. Try again.';
  return 'The network rejected it: ' + m.slice(0, 160);
}
