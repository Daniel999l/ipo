// Everything that talks to the pump.fun programs.
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import sdk from './pumpsdk.js';

const { PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda, isSharingConfigEditable, bondingCurvePda, canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, creatorVaultPda } = sdk;
export { PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda, bondingCurvePda, canonicalPumpPoolPda, creatorVaultPda };
export const PUMP_PROGRAM_ID = sdk.PUMP_PROGRAM_ID;
export const PUMP_AMM_PROGRAM_ID = sdk.PUMP_AMM_PROGRAM_ID;
export const TOTAL_SUPPLY = new BN('1000000000000000'); // 1B tokens, 6 decimals

// the fee split every coin gets: `potBps` to its handle vault, the rest to the $IPO buyback wallet
export function feeShares(pot, { buyback, potBps = 8000 } = {}) {
  const shares = [{ address: new PublicKey(pot), shareBps: potBps }];
  if (potBps < 10000) {
    if (!buyback) throw new Error('buyback wallet missing');
    shares.push({ address: new PublicKey(buyback), shareBps: 10000 - potBps });
  }
  return shares;
}

// create coin (Token-2022, SOL quote) + opt into fee sharing + lock the split (handle vault + buyback). Admin is revoked by the update.
export async function launchInstructions({ mint, creator, pot, name, symbol, uri, buyback, potBps = 8000 }) {
  const create = await PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator, user: creator, mayhemMode: false });
  const cfg = await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
  const lock = await PUMP_SDK.updateFeeSharesV2({ authority: creator, mint, currentShareholders: [creator], newShareholders: feeShares(pot, { buyback, potBps }), quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID });
  return [create, cfg, lock];
}

// Reads the chain and says whether this coin's creator fees are locked forever to exactly the expected split.
export async function verifyLock(conn, mint, pot, { buyback, potBps = 8000 } = {}) {
  const mintPk = new PublicKey(mint);
  const scAddr = feeSharingConfigPda(mintPk);
  const [scInfo, bcInfo] = await conn.getMultipleAccountsInfo([scAddr, bondingCurvePda(mintPk)], 'confirmed');
  if (!scInfo || !bcInfo) return { ok: false, reason: 'coin or fee config not found' };
  const sc = PUMP_SDK.decodeSharingConfig(scInfo);
  const bc = PUMP_SDK.decodeBondingCurve(bcInfo);
  const sh = sc.shareholders.map(s => ({ address: s.address.toBase58(), bps: s.shareBps }));
  const want = feeShares(pot, { buyback, potBps }).map(s => ({ address: s.address.toBase58(), bps: s.shareBps }));
  const same = sh.length === want.length && want.every(w => sh.some(s => s.address === w.address && s.bps === w.bps));
  const ok = sc.adminRevoked && !isSharingConfigEditable({ sharingConfig: sc }) && same && bc.creator.equals(scAddr);
  const potAddr = new PublicKey(pot).toBase58();
  const labeled = sh.map(s => ({ ...s, role: s.address === potAddr ? 'handle' : s.address === want[1]?.address ? 'buyback' : 'other' }));
  return { ok, reason: ok ? null : 'fees are not locked to this vault', adminRevoked: sc.adminRevoked, shareholders: labeled, curveCreator: bc.creator.toBase58(), sharingConfig: scAddr.toBase58() };
}

export async function curveState(conn, mint) {
  const info = await conn.getAccountInfo(bondingCurvePda(new PublicKey(mint)), 'confirmed');
  if (!info) return null;
  const bc = PUMP_SDK.decodeBondingCurve(info);
  return { complete: bc.complete, virtualSol: bc.virtualQuoteReserves ?? bc.virtualSolReserves, virtualToken: bc.virtualTokenReserves, realSol: bc.realQuoteReserves ?? bc.realSolReserves, realToken: bc.realTokenReserves, creator: bc.creator.toBase58(), raw: bc };
}

// Instructions that move accrued creator fees into the vault (works before and after graduation). Permissionless.
export async function distributeInstructions(conn, mint, payer) {
  const online = new OnlinePumpSdk(conn);
  return online.buildDistributeCreatorFeesInstructions(new PublicKey(mint), { payer });
}

// Unclaimed creator fees sitting in pump vaults for this coin (lamports).
export async function pendingFees(conn, mint) {
  const online = new OnlinePumpSdk(conn);
  const sc = feeSharingConfigPda(new PublicKey(mint));
  return BigInt((await online.getCreatorVaultBalanceBothPrograms(sc)).toString());
}

// Trading helpers. The site builds these for the user's wallet to sign; it never trades itself.
export async function buyIxs(conn, { mint, user, solLamports, slippage = 5 }) {
  const online = new OnlinePumpSdk(conn);
  const mintPk = new PublicKey(mint);
  const [global, feeConfig, st, supply] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig(), online.fetchBuyState(mintPk, user, TOKEN_2022_PROGRAM_ID), conn.getTokenSupply(mintPk)]);
  const quoteAmount = new BN(solLamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: new BN(supply.value.amount), bondingCurve: st.bondingCurve, amount: quoteAmount });
  return PUMP_SDK.buyV2Instructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user, amount, quoteAmount, slippage, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID });
}

export async function sellIxs(conn, { mint, user, tokenAmount, slippage = 5 }) {
  const online = new OnlinePumpSdk(conn);
  const mintPk = new PublicKey(mint);
  const [global, feeConfig, st, supply] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig(), online.fetchSellState(mintPk, user, TOKEN_2022_PROGRAM_ID), conn.getTokenSupply(mintPk)]);
  const amount = new BN(tokenAmount.toString());
  const quoteAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: new BN(supply.value.amount), bondingCurve: st.bondingCurve, amount });
  return PUMP_SDK.sellV2Instructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, mint: mintPk, user, amount, quoteAmount, slippage, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID });
}

export { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

// After graduation: trade on PumpSwap.
import { swap } from './pumpsdk.js';
export async function ammBuyIxs(conn, { mint, user, solLamports, slippage = 5 }) {
  const online = new swap.OnlinePumpAmmSdk(conn);
  const st = await online.swapSolanaState(canonicalPumpPoolPda(new PublicKey(mint)), user);
  return swap.PUMP_AMM_SDK.buyQuoteInput(st, new BN(solLamports.toString()), slippage);
}
export async function ammSellIxs(conn, { mint, user, tokenAmount, slippage = 5 }) {
  const online = new swap.OnlinePumpAmmSdk(conn);
  const st = await online.swapSolanaState(canonicalPumpPoolPda(new PublicKey(mint)), user);
  return swap.PUMP_AMM_SDK.sellBaseInput(st, new BN(tokenAmount.toString()), slippage);
}
export async function migrateIxs(conn, { mint, user }) {
  const g = await new OnlinePumpSdk(conn).fetchGlobal();
  return [await PUMP_SDK.migrateV2Instruction({ withdrawAuthority: g.withdrawAuthority, mint: new PublicKey(mint), user, quoteMint: NATIVE_MINT, baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID })];
}
