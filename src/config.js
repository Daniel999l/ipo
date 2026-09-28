// All settings. Only values WITHOUT a default go in .env (see .env.example); everything else is an optional override (see README).
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

export function loadConfig(overrides = {}) {
  const c = {
    port: num('PORT', 3000),
    rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
    mongoUrl: env('MONGO_URL'),
    dbName: env('DB_NAME', 'ipo'),
    operatorSecret: env('OPERATOR_SECRET'), // base58 secret key of the wallet that pays network fees for sweeps and payouts
    vaultMasterKey: env('VAULT_MASTER_KEY'), // 64 hex chars, encrypts every handle vault key at rest
    tokenCa: env('TOKEN_CA', ''), // the $IPO contract address (empty = the site shows "launching soon")
    publicUrl: env('PUBLIC_URL', 'https://useipo.up.railway.app'), // site address, used for the website link on each coin
    xHandle: env('X_HANDLE', 'ipoanyone'),
    // listing
    listingFeeSol: num('LISTING_FEE_SOL', 0.05), // paid to the treasury in the same transaction that creates the coin
    devBuySol: num('DEV_BUY_SOL', 0.00001), // tiny first buy right after the coin is created
    handleShareBps: num('HANDLE_SHARE_BPS', 8000), // 8000 = 80% of each coin's creator fees to its handle vault, the rest to BUYBACK_WALLET
    treasuryWallet: env('TREASURY_WALLET', ''), // gets listing fees (empty = the operator wallet)
    buybackWallet: env('BUYBACK_WALLET', ''), // gets the other 20% of creator fees (empty = the operator wallet)
    coinImage: env('COIN_IMAGE', 'public/coin.png'), // image used for every listed coin on pump.fun
    metadataMode: env('METADATA_MODE', 'pump'), // pump = upload to pump.fun IPFS, self = serve from this server
    pumpIpfsUrl: env('PUMP_IPFS_URL', 'https://pump.fun/api/ipfs'),
    profileUrl: env('PROFILE_URL', 'https://api.fxtwitter.com'), // X names, bios, followers and pictures; empty = off
    avatarUrl: env('AVATAR_URL', 'https://unavatar.io/x'), // backup profile pictures; empty = off (initials only)
    checkHandles: env('CHECK_HANDLES', 'true') === 'true', // refuse handles that don't exist on X
    listRatePerHour: num('LIST_RATE_PER_HOUR', 20),
    reserveSeconds: num('RESERVE_SECONDS', 150), // a handle is held for one wallet while it signs
    mintSuffix: env('MINT_SUFFIX', 'ipo'), // every coin listed here gets an address ending in this (empty = off)
    mintPoolSize: num('MINT_POOL_SIZE', 10),
    vaultReserveLamports: num('VAULT_RESERVE_LAMPORTS', 890_880), // rent-exempt minimum kept in every vault
    // fees + markets
    collectEveryMinutes: num('COLLECT_EVERY_MINUTES', 10),
    minCollectLamports: num('MIN_COLLECT_LAMPORTS', 5_000_000),
    refreshEveryMinutes: num('REFRESH_EVERY_MINUTES', 1),
    marketUrl: env('MARKET_URL', 'https://api.dexscreener.com/latest/dex/tokens'), // 24h volume, empty = off
    priorityMicroLamports: num('PRIORITY_MICROLAMPORTS', 20000),
    maxTradeSol: num('MAX_TRADE_SOL', 100),
    lutAddress: env('LUT_ADDRESS', ''), // created automatically on first start if empty
    solPriceUrl: env('SOL_PRICE_URL', 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112'),
    schedulerTickMs: num('SCHEDULER_TICK_MS', 15000),
    ...overrides,
  };
  const missing = ['mongoUrl', 'operatorSecret', 'vaultMasterKey'].filter(k => !c[k]);
  if (missing.length) throw new Error('Missing required settings: ' + missing.map(k => k.replace(/[A-Z]/g, m => '_' + m).toUpperCase()).join(', '));
  if (!/^[0-9a-fA-F]{64}$/.test(c.vaultMasterKey)) throw new Error('VAULT_MASTER_KEY must be 64 hex characters (32 bytes)');
  c.operator = c.operator || Keypair.fromSecretKey(bs58.decode(c.operatorSecret));
  if (!(c.handleShareBps > 0 && c.handleShareBps <= 10000 && Number.isInteger(c.handleShareBps))) throw new Error('HANDLE_SHARE_BPS must be a whole number from 1 to 10000');
  c.buyback = c.buybackWallet ? new PublicKey(c.buybackWallet) : c.operator.publicKey;
  c.treasury = c.treasuryWallet ? new PublicKey(c.treasuryWallet) : c.operator.publicKey;
  c.listingFeeLamports = Math.round(c.listingFeeSol * 1e9);
  c.devBuyLamports = Math.round(c.devBuySol * 1e9);
  return c;
}
