// Robinhood Chain: provider, house wallet, per-handle vault wallets, contracts and a safe transaction sender.
import { ethers } from 'ethers';

export const ABI = {
  factory: [
    'function launchEnabled() view returns (bool)',
    'function launchFee() view returns (uint256)',
    'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
    'function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
    'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
    'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  ],
  curve: [
    'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
    'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
    'function creatorTaxBalance() view returns (uint256)',
    'function graduated() view returns (bool)',
    'function sweepFees(uint256 minBuybackTokensOut)',
    'function trackedQuote() view returns (uint256)',
    'function graduationThreshold() view returns (uint256)',
    'function currentSnipeTaxBps(address) view returns (uint256)',
    'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  ],
  escrow: [
    'function balanceOf(address account) view returns (uint256)',
    'function claim(uint256 amount)',
  ],
  erc20: [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfer(address to, uint256 amount) returns (bool)',
  ],
};
export const IFACE = Object.fromEntries(Object.entries(ABI).map(([k, v]) => [k, new ethers.Interface(v)]));

// poll for a receipt (does not depend on new-block events, so it never hangs); null after `ms`
export async function waitReceipt(provider, hash, ms = 180000) {
  const end = Date.now() + ms;
  for (;;) {
    const rc = await provider.getTransactionReceipt(hash).catch(() => null);
    if (rc) return rc;
    if (Date.now() > end) return null;
    await new Promise(r => setTimeout(r, 1000));
  }
}

export function makeChain(cfg) {
  // cacheTimeout -1: always read fresh balances (ethers otherwise reuses a read for a moment)
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 1000;
  const house = new ethers.Wallet(cfg.housePrivateKey, provider);

  // one queue for everything the house signs, so nonces never collide
  let queue = Promise.resolve();
  let nextNonce = null;
  const houseTx = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  async function claimNonce() {
    const pending = await provider.getTransactionCount(house.address, 'pending');
    if (nextNonce === null || pending > nextNonce) nextNonce = pending;
    return nextNonce++;
  }

  // sign, let the caller save the hash (onSigned), then broadcast and wait
  async function sendSigned(wallet, req, { onSigned } = {}) {
    const isHouse = wallet.address === house.address;
    const tx = { ...req, chainId: cfg.chainId, type: 2 };
    if (tx.gasLimit == null) tx.gasLimit = (await provider.estimateGas({ ...req, from: wallet.address })) * 130n / 100n;
    const fee = await provider.getFeeData();
    tx.maxFeePerGas = tx.maxFeePerGas ?? (fee.maxFeePerGas ?? fee.gasPrice) * 2n;
    tx.maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? (fee.maxPriorityFeePerGas ?? 0n);
    if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) tx.maxPriorityFeePerGas = tx.maxFeePerGas;
    let hash;
    try {
      tx.nonce = isHouse ? await claimNonce() : await provider.getTransactionCount(wallet.address, 'pending');
      const raw = await wallet.signTransaction(tx);
      hash = ethers.keccak256(raw);
      if (onSigned) await onSigned({ hash, raw, nonce: tx.nonce });
      await provider.broadcastTransaction(raw);
    } catch (e) { if (isHouse) nextNonce = null; throw e; }
    const rc = await waitReceipt(provider, hash, 180000);
    if (!rc) throw new Error('transaction not mined in time: ' + hash);
    if (rc.status !== 1) throw new Error('transaction reverted: ' + hash);
    return rc;
  }

  // Each listed handle gets its own fee vault, derived from the house key. Nothing else to back up.
  const vaultWallet = index => new ethers.Wallet(ethers.keccak256(ethers.concat([cfg.housePrivateKey, ethers.toUtf8Bytes('ipo-vault'), ethers.toBeHex(index, 32)])), provider);

  // a vault sends something; the house tops it up with exactly the gas it lacks first
  async function vaultCall(vault, req, opts) {
    const gasLimit = req.gasLimit ?? (await provider.estimateGas({ ...req, from: vault.address })) * 130n / 100n;
    const f = await provider.getFeeData();
    const maxFeePerGas = (f.maxFeePerGas ?? f.gasPrice) * 2n;
    const need = gasLimit * maxFeePerGas + (req.value ?? 0n);
    const bal = await provider.getBalance(vault.address);
    if (bal < need) {
      const gap = need - bal;
      await houseTx(() => sendSigned(house, { to: vault.address, value: gap > cfg.vaultGasTopupWei ? gap : cfg.vaultGasTopupWei, gasLimit: 21000n }));
    }
    return sendSigned(vault, { ...req, gasLimit, maxFeePerGas }, opts);
  }

  const factory = new ethers.Contract(cfg.ponsFactory, ABI.factory, provider);
  const escrow = new ethers.Contract(cfg.ponsFeeEscrow, ABI.escrow, provider);
  const curveAt = addr => new ethers.Contract(addr, ABI.curve, provider);
  const erc20 = addr => new ethers.Contract(addr, ABI.erc20, provider);
  return { provider, house, houseTx, sendSigned, vaultWallet, vaultCall, factory, escrow, curveAt, erc20 };
}
