// Buy and sell on the Pons curve from the user's own wallet. We only build the transaction; the wallet signs and sends it.
// After a coin graduates, trading moves to its pool and the site sends people to the Pons page instead.
import { ethers } from 'ethers';
import { IFACE } from './chain.js';
import { UserError } from './pons.js';

export async function tokenBalance(ctx, token, owner) {
  try { return await ctx.chain.erc20(token).balanceOf(owner); } catch { return 0n; }
}

export async function prepareTrade(ctx, { token, wallet, side, eth, percent, slippage = 10 }) {
  const { chain, cfg, db } = ctx;
  if (!ethers.isAddress(wallet)) throw new UserError('Connect a wallet first.');
  const coin = await db.coins.findOne({ token: ethers.isAddress(token) ? ethers.getAddress(token) : String(token) });
  if (!coin) throw new UserError('Market not found.', 404);
  const cv = chain.curveAt(coin.curve);
  if (await cv.graduated().catch(() => false)) throw Object.assign(new UserError('This account graduated. Trade it on Pons.', 409), { graduated: true, url: cfg.ponsTokenPage + coin.token });
  const slip = BigInt(Math.round(Math.min(50, Math.max(1, Number(slippage) || 10)) * 100));
  const from = ethers.getAddress(wallet);

  if (side === 'buy') {
    const v = Number(eth);
    if (!(v > 0) || v > cfg.maxTradeEth) throw new UserError(`Enter an amount between 0 and ${cfg.maxTradeEth} ETH.`);
    const value = ethers.parseEther(String(v));
    let out;
    try { out = await cv.buy.staticCall(value, 0, from, { value, from }); }
    catch (e) { throw new UserError(/insufficient funds/i.test(e.message) ? 'Not enough ETH in your wallet.' : 'The market would not take this buy right now. Try a different amount.'); }
    const min = out * (10000n - slip) / 10000n;
    return { tx: { to: coin.curve, data: IFACE.curve.encodeFunctionData('buy', [value, min, from]), value: '0x' + value.toString(16) }, expectTokens: out.toString() };
  }
  if (side === 'sell') {
    const p = Number(percent);
    if (!(p > 0 && p <= 100)) throw new UserError('Choose how much to sell.');
    const t = chain.erc20(coin.token);
    const bal = await t.balanceOf(from);
    if (bal === 0n) throw new UserError('You do not hold any of this yet.');
    const amount = p >= 100 ? bal : bal * BigInt(Math.round(p * 100)) / 10000n;
    if (amount === 0n) throw new UserError('Amount too small.');
    // the curve takes the tokens itself, so it needs permission once
    if ((await t.allowance(from, coin.curve)) < amount) {
      return { approve: { to: coin.token, data: IFACE.erc20.encodeFunctionData('approve', [coin.curve, ethers.MaxUint256]), value: '0x0' } };
    }
    let out;
    try { out = await cv.sell.staticCall(amount, 0, from, { from }); }
    catch { throw new UserError('The market would not take this sell right now. Try a smaller amount.'); }
    const min = out * (10000n - slip) / 10000n;
    return { tx: { to: coin.curve, data: IFACE.curve.encodeFunctionData('sell', [amount, min, from]), value: '0x0' }, expectEth: ethers.formatEther(out) };
  }
  throw new UserError('Choose buy or sell.');
}
