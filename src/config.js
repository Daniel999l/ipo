// All settings. Only values WITHOUT a default go in .env (see .env.example); everything else is an optional override (see README).
import { ethers } from 'ethers';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

export function loadConfig(overrides = {}) {
  const c = {
    port: num('PORT', 3000),
    mongoUrl: env('MONGO_URL', env('MONGODB_URI')),
    dbName: env('DB_NAME', 'ipo'),
    housePrivateKey: env('HOUSE_PRIVATE_KEY'), // brand new wallet: takes listing payments, launches coins, pays gas for fee collection
    tokenCa: env('TOKEN_CA', ''), // the $IPO contract on Pons (empty = the site shows "launching soon")
    publicUrl: env('PUBLIC_URL', 'https://useipo.up.railway.app'),
    xHandle: env('X_HANDLE', 'ipoanyone'),
    // Robinhood Chain + Pons
    rpcUrl: /solana|helius/i.test(env('RPC_URL', '')) ? 'https://rpc.mainnet.chain.robinhood.com' : env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'), // a Solana RPC left over from the old version is ignored
    chainId: 4663,
    explorer: 'https://robinhoodchain.blockscout.com',
    ponsFactory: env('PONS_FACTORY', '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'),
    ponsFeeEscrow: env('PONS_FEE_ESCROW', '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'),
    ponsApi: env('PONS_API_BASE', 'https://www.ponsfamily.com/api'),
    ponsImageUpload: env('PONS_IMAGE_UPLOAD', 'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image'),
    ponsTokenPage: 'https://www.ponsfamily.com/launchpad/',
    skipImageUpload: env('SKIP_IMAGE_UPLOAD', '') === '1',
    // listing
    listingFeeEth: env('LISTING_FEE_ETH', '0.002'), // what the lister pays; covers the Pons launch fee and gas, the rest is yours
    creatorTaxBps: num('CREATOR_TAX_BPS', 200), // creator fee on every trade of a listed coin (200 = 2%), paid to the handle's vault
    handleShareBps: num('HANDLE_SHARE_BPS', 8000), // 80% of collected fees are owed to the account owner, the rest goes to BUYBACK_WALLET
    buybackWallet: env('BUYBACK_WALLET', ''), // gets the 20% (empty = the house wallet)
    coinImage: env('COIN_IMAGE', 'public/coin.png'),
    reserveMinutes: num('RESERVE_MINUTES', 10), // a handle is held for the wallet that is paying
    listRatePerHour: num('LIST_RATE_PER_HOUR', 20),
    // profiles
    profileUrl: env('PROFILE_URL', 'https://api.fxtwitter.com'),
    avatarUrl: env('AVATAR_URL', 'https://unavatar.io/x'),
    checkHandles: env('CHECK_HANDLES', 'true') === 'true',
    // fees + markets
    collectEveryMinutes: num('COLLECT_EVERY_MINUTES', 60),
    minSweepEth: env('MIN_SWEEP_ETH', '0.0005'), // skip sweeps/claims smaller than this (the gas would eat it)
    vaultGasTopupEth: env('VAULT_GAS_TOPUP_ETH', '0.00005'),
    refreshEveryMinutes: num('REFRESH_EVERY_MINUTES', 1),
    maxTradeEth: num('MAX_TRADE_ETH', 20),
    schedulerTickMs: num('SCHEDULER_TICK_MS', 15000),
    ...overrides,
  };
  const missing = ['mongoUrl', 'housePrivateKey'].filter(k => !c[k]);
  if (missing.length) throw new Error('Missing required settings: ' + missing.map(k => ({ mongoUrl: 'MONGO_URL', housePrivateKey: 'HOUSE_PRIVATE_KEY' })[k]).join(', '));
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(c.housePrivateKey)) throw new Error('HOUSE_PRIVATE_KEY must be a 64 character hex private key');
  if (!c.housePrivateKey.startsWith('0x')) c.housePrivateKey = '0x' + c.housePrivateKey;
  if (!(c.creatorTaxBps > 0 && c.creatorTaxBps <= 1000)) throw new Error('CREATOR_TAX_BPS must be between 1 and 1000');
  if (!(c.handleShareBps >= 0 && c.handleShareBps <= 10000)) throw new Error('HANDLE_SHARE_BPS must be between 0 and 10000');
  if (c.buybackWallet && !ethers.isAddress(c.buybackWallet)) throw new Error('BUYBACK_WALLET is not a valid address');
  if (c.tokenCa && !ethers.isAddress(c.tokenCa)) throw new Error('TOKEN_CA is not a valid address');
  c.listingFeeWei = ethers.parseEther(String(c.listingFeeEth));
  c.minSweepWei = ethers.parseEther(String(c.minSweepEth));
  c.vaultGasTopupWei = ethers.parseEther(String(c.vaultGasTopupEth));
  return c;
}
