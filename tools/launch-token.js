// Launch $IPO on Pons from YOUR wallet. Creator fees go to that wallet.
//
//   npm run launch-token                          checks everything and simulates, launches nothing
//   npm run launch-token -- --yes                 launches for real
//   npm run launch-token -- --yes --buy 0.01      launches, then buys 0.01 ETH of it
//
// Reads LAUNCH_PRIVATE_KEY (your launch wallet) and RPC_URL from .env. With MONGO_URL (Railway's PUBLIC Mongo URL)
// it also saves the address to the site database, so the site shows it within a minute.
// Pons charges a 99% snipe tax for the first 3 seconds of a coin's life, so the optional buy waits 5 seconds.
import 'dotenv/config';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { MongoClient } from 'mongodb';
import { ABI, IFACE } from '../src/chain.js';
import { uploadImage, launchedFromReceipt } from '../src/pons.js';

const FACTORY = process.env.PONS_FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const has = k => a.includes('--' + k);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launchToken({ rpc, wallet, name, symbol, description, image, logo, website, twitter, taxBps = 200, buyEth = 0, send = false, log = console.log, skipUpload = false }) {
  const provider = new ethers.JsonRpcProvider(rpc, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  const signer = new ethers.NonceManager(wallet.connect(provider));
  const factory = new ethers.Contract(FACTORY, ABI.factory, signer);
  if (!logo) logo = await uploadImage({ skipImageUpload: skipUpload, ponsImageUpload: 'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image' }, readFileSync(image), 'image/png');
  log('Logo:', logo);
  const [enabled, fee, econ] = await Promise.all([factory.launchEnabled(), factory.launchFee(), factory.previewLaunchEconomics(0, ethers.ZeroAddress)]);
  if (!enabled) throw new Error('Pons launches are paused right now.');
  const params = { name, symbol, logo, description, socials: { twitter: twitter || '', telegram: '', discord: '', website: website || '', farcaster: '' }, creatorFeeRecipient: wallet.address, creatorTaxBps: taxBps, buybackEnabled: false, expectedEconomics: econ, salt: ethers.hexlify(ethers.randomBytes(32)) };
  const args = [params, 0, ethers.ZeroAddress, []];
  const bal = await provider.getBalance(wallet.address);
  log(`\nToken:     ${name} ($${symbol})\nCreator:   ${wallet.address} (balance ${ethers.formatEther(bal)} ETH)\nLaunch fee ${ethers.formatEther(fee)} ETH, creator fee ${taxBps / 100}%, first buy ${buyEth} ETH\n`);
  const [token] = await factory.launchToken.staticCall(...args, { value: fee, from: wallet.address });
  log('Simulation passed. It would create', token);
  if (!send) { log('Dry run only. Add --yes to launch for real.'); return { sent: false }; }
  const rc = await (await factory.launchToken(...args, { value: fee })).wait();
  const ev = launchedFromReceipt(rc);
  log(`\nLaunched! https://www.ponsfamily.com/launchpad/${ev.token}\nTransaction: ${rc.hash}`);
  if (buyEth > 0) {
    await sleep(5000);
    const curve = new ethers.Contract(ev.curve, ABI.curve, signer);
    const value = ethers.parseEther(String(buyEth));
    const out = await curve.buy.staticCall(value, 0, wallet.address, { value });
    await (await curve.buy(value, out * 95n / 100n, wallet.address, { value })).wait();
    log(`Bought ${ethers.formatEther(out)} $${symbol} for ${buyEth} ETH`);
  }
  return { sent: true, token: ev.token, curve: ev.curve, hash: rc.hash };
}

if (process.argv[1]?.endsWith('launch-token.js')) {
  try {
    if (!process.env.LAUNCH_PRIVATE_KEY) throw new Error('Add LAUNCH_PRIVATE_KEY=<your launch wallet private key> to .env');
    const key = process.env.LAUNCH_PRIVATE_KEY.trim();
    const r = await launchToken({
      rpc: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', wallet: new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key),
      name: opt('name', 'IPO'), symbol: opt('symbol', 'IPO'), description: opt('description', 'Take any X account public.'),
      image: opt('image', 'public/ipo-token.png'), logo: opt('logo'),
      website: opt('website', process.env.PUBLIC_URL || 'https://useipo.up.railway.app'), twitter: opt('twitter', `https://x.com/${process.env.X_HANDLE || 'ipoanyone'}`),
      taxBps: Number(opt('tax', '200')), buyEth: Number(opt('buy', '0')), send: has('yes'),
    });
    if (r.sent) {
      if (process.env.MONGO_URL) {
        const c = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
        try { await c.connect(); await c.db(process.env.DB_NAME || 'ipo').collection('settings').updateOne({ _id: 'tokenCa' }, { $set: { value: r.token } }, { upsert: true }); console.log('Saved to the site database. The site shows it within a minute.'); }
        catch (e) { console.log(`Could not reach the site database (${e.message}). Set TOKEN_CA=${r.token} on Railway instead.`); }
        finally { await c.close().catch(() => {}); }
      } else console.log(`Set TOKEN_CA=${r.token} on Railway.`);
    }
    process.exit(0);
  } catch (e) { console.error('\n' + (e.shortMessage || e.message)); process.exit(1); }
}
