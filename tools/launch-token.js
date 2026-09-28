// Launch $IPO on pump.fun from YOUR wallet with a custom address (from `npm run grind`).
// Creator fees go to your wallet.
//
//   npm run launch-token            checks everything and simulates (launches nothing)
//   npm run launch-token -- --yes   launches for real
//
// Reads LAUNCH_WALLET_SECRET (your launch wallet's private key) and RPC_URL from .env,
// uses the newest address from `npm run grind`, and makes a 0.1 SOL first buy in the same transaction.
import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import bs58 from 'bs58';
import BN from 'bn.js';
import sdk from '../src/pumpsdk.js';
import { buildV0, budgetIxs, sendSigned } from '../src/tx.js';
import { commonKeys, createLut, loadLut } from '../src/lut.js';
import { MongoClient } from 'mongodb';

// Tells the live site the $IPO address (no Railway restart needed).
export async function saveTokenCa({ mongoUrl, dbName = 'ipo', ca }) {
  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 15000 });
  try { await client.connect(); await client.db(dbName).collection('settings').updateOne({ _id: 'tokenCa' }, { $set: { value: ca } }, { upsert: true }); }
  finally { await client.close(); }
}

const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = sdk;
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const has = k => a.includes('--' + k);

function keyFromText(raw) {
  raw = String(raw).trim();
  return raw.startsWith('[') ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : Keypair.fromSecretKey(bs58.decode(raw));
}
function readKey(path) { return keyFromText(readFileSync(path, 'utf8')); }

// newest address found by `npm run grind` (keys/mint-....json), preferring ones ending in "ipo"
function newestMintFile() {
  let files = [];
  try { files = readdirSync('keys').filter(f => /^mint-.+\.json$/.test(f)).map(f => 'keys/' + f); } catch {}
  if (!files.length) throw new Error('No address found in keys/. Run: npm run grind -- ipo');
  const lock = files.filter(f => f.endsWith('ipo.json'));
  return (lock.length ? lock : files).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export async function launchToken({ rpc, mint, wallet, name, symbol, description, image, twitter, telegram, website, uri, devBuySol = 0, send = false, lutAddress, saveTo, log = console.log }) {
  const conn = new Connection(rpc, 'confirmed');
  if (!uri) {
    const form = new FormData();
    const buf = readFileSync(image);
    form.append('file', new Blob([buf], { type: image.endsWith('.jpg') || image.endsWith('.jpeg') ? 'image/jpeg' : 'image/png' }), 'token.png');
    for (const [k, v] of Object.entries({ name, symbol, description, twitter, telegram, website })) if (v) form.append(k, v);
    form.append('showName', 'true');
    const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: form });
    if (!r.ok) throw new Error('Image upload to pump.fun failed: ' + r.status);
    uri = (await r.json()).metadataUri;
    log('Metadata uploaded:', uri);
  }
  const online = new OnlinePumpSdk(conn);
  const global = await online.fetchGlobal();
  let ixs, luts = [];
  if (devBuySol > 0) {
    const feeConfig = await online.fetchFeeConfig();
    const quoteAmount = new BN(Math.round(devBuySol * LAMPORTS_PER_SOL));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount });
    const build = (m, w) => PUMP_SDK.createV2AndBuyV2Instructions({ global, mint: m, name, symbol, uri, creator: w, user: w, amount, quoteAmount, mayhemMode: false });
    ixs = await build(mint.publicKey, wallet.publicKey);
    // create + first buy is too big for one plain transaction, so put the shared pump.fun accounts in a lookup table
    if (lutAddress) luts = [await loadLut(conn, lutAddress)];
    else if (send) {
      log('Creating a lookup table so launch + first buy fit in one transaction (about 0.003 SOL)...');
      const keys = await commonKeys(() => build(Keypair.generate().publicKey, Keypair.generate().publicKey));
      const addr = await createLut(conn, wallet, keys);
      luts = [await loadLut(conn, addr)];
      log('Lookup table:', addr.toBase58(), '(pass --lut ' + addr.toBase58() + ' to reuse it)');
    }
  } else {
    ixs = [await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri, creator: wallet.publicKey, user: wallet.publicKey, mayhemMode: false })];
  }
  const bal = await conn.getBalance(wallet.publicKey);
  log(`\nToken:    ${name} ($${symbol})\nAddress:  ${mint.publicKey.toBase58()}\nCreator:  ${wallet.publicKey.toBase58()} (balance ${(bal / 1e9).toFixed(4)} SOL)\nFirst buy: ${devBuySol} SOL\n`);
  // dry run without a table: check the create alone (the buy is the standard pump.fun buy)
  const simIxs = luts.length || devBuySol === 0 ? ixs : ixs.slice(0, 1);
  const { tx: simTx } = await buildV0(conn, { payer: wallet.publicKey, ixs: [...budgetIxs({ units: 400000 }), ...simIxs], luts });
  simTx.sign([wallet, mint]);
  const sim = await conn.simulateTransaction(simTx, { sigVerify: true });
  if (sim.value.err) throw new Error('Simulation failed: ' + JSON.stringify(sim.value.err) + '\n' + (sim.value.logs || []).slice(-8).join('\n'));
  log('Simulation passed.');
  if (!send) { log('Dry run only. Add --yes to launch for real.'); return { mint: mint.publicKey.toBase58(), sent: false }; }
  const { tx, blockhash } = await buildV0(conn, { payer: wallet.publicKey, ixs: [...budgetIxs({ units: 400000, microLamports: 100000 }), ...ixs], luts });
  tx.sign([wallet, mint]);
  const sig = await sendSigned(conn, tx, blockhash);
  const ca = mint.publicKey.toBase58();
  log(`\nLaunched! https://pump.fun/coin/${ca}\nTransaction: ${sig}`);
  if (saveTo?.mongoUrl) {
    try { await saveTokenCa({ ...saveTo, ca }); log('Saved to the site database. The site shows it within a minute, no restart needed.'); }
    catch (e) { log(`Could not reach the site database (${e.message}). Set TOKEN_CA=${ca} on Railway instead.`); }
  } else log(`Set TOKEN_CA=${ca} on Railway (or add MONGO_URL to .env so this saves it automatically).`);
  return { mint: ca, sent: true, sig };
}

if (process.argv[1]?.endsWith('launch-token.js')) {
  try {
    const walletSecret = opt('wallet') ? null : process.env.LAUNCH_WALLET_SECRET;
    if (!opt('wallet') && !walletSecret) throw new Error('Add LAUNCH_WALLET_SECRET=<your launch wallet private key> to .env');
    const mintFile = opt('mint') || newestMintFile();
    console.log('Using address from', mintFile);
    await launchToken({
      rpc: opt('rpc', process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'),
      mint: readKey(mintFile), wallet: opt('wallet') ? readKey(opt('wallet')) : keyFromText(walletSecret),
      name: opt('name', 'IPO'), symbol: opt('symbol', 'IPO'),
      description: opt('description', 'Take any X account public.'),
      image: opt('image', 'public/ipo-token.png'), twitter: opt('twitter', process.env.X_HANDLE ? `https://x.com/${process.env.X_HANDLE}` : undefined), telegram: opt('telegram'), website: opt('website', process.env.PUBLIC_URL),
      uri: opt('uri'), devBuySol: Number(opt('dev-buy', '0.1')), send: has('yes'), lutAddress: opt('lut'),
      saveTo: process.env.MONGO_URL ? { mongoUrl: process.env.MONGO_URL, dbName: process.env.DB_NAME || 'ipo' } : null,
    });
    process.exit(0);
  } catch (e) { console.error('\n' + e.message); process.exit(1); }
}
