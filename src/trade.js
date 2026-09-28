// Buy and sell for the user's own wallet. We only build the transaction; the user's wallet signs and sends it.
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buyIxs, sellIxs, ammBuyIxs, ammSellIxs, curveState, TOKEN_2022_PROGRAM_ID } from './pump.js';
import { buildV0, budgetIxs } from './tx.js';
import { LaunchError } from './launch.js';

export async function tokenBalance(conn, mint, owner) {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID);
    return BigInt((await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount);
  } catch { return 0n; }
}

export async function prepareTrade(ctx, { mint, wallet, side, sol, percent, slippage = 10 }) {
  const { conn, cfg, db, lut } = ctx;
  let user;
  try { user = new PublicKey(wallet); } catch { throw new LaunchError('Connect a wallet first.'); }
  const coin = await db.coins.findOne({ mint: String(mint) }, { projection: { mint: 1 } });
  if (!coin) throw new LaunchError('Market not found.', 404);
  const slip = Math.min(50, Math.max(1, Number(slippage) || 10));
  const cs = await curveState(conn, coin.mint);
  if (!cs) throw new LaunchError('Market not found.', 404);
  let ixs;
  if (side === 'buy') {
    const s = Number(sol);
    if (!(s > 0) || s > cfg.maxTradeSol) throw new LaunchError(`Enter an amount between 0 and ${cfg.maxTradeSol} SOL.`);
    const lamports = BigInt(Math.round(s * 1e9));
    ixs = cs.complete ? await ammBuyIxs(conn, { mint: coin.mint, user, solLamports: lamports, slippage: slip }) : await buyIxs(conn, { mint: coin.mint, user, solLamports: lamports, slippage: slip });
  } else if (side === 'sell') {
    const p = Number(percent);
    if (!(p > 0 && p <= 100)) throw new LaunchError('Choose how much to sell.');
    const bal = await tokenBalance(conn, coin.mint, user);
    if (bal === 0n) throw new LaunchError('You do not hold any of this yet.');
    const amount = p >= 100 ? bal : bal * BigInt(Math.round(p * 100)) / 10000n;
    if (amount === 0n) throw new LaunchError('Amount too small.');
    ixs = cs.complete ? await ammSellIxs(conn, { mint: coin.mint, user, tokenAmount: amount, slippage: slip }) : await sellIxs(conn, { mint: coin.mint, user, tokenAmount: amount, slippage: slip });
  } else throw new LaunchError('Choose buy or sell.');
  const { tx } = await buildV0(conn, { payer: user, ixs: [...budgetIxs({ units: 300000, microLamports: cfg.priorityMicroLamports }), ...ixs], luts: lut ? [lut] : [] });
  return { tx: Buffer.from(tx.serialize()).toString('base64') };
}
