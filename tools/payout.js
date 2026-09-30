// Pay an account owner their collected fees, by hand, after you checked their claim.
//
//   npm run claims                       claims waiting for review (with the post link to check)
//   npm run payout -- @handle            pays the wallet from the newest reviewed claim for @handle
//   npm run payout -- @handle <wallet>   pays a wallet you choose
//
// Reads MONGO_URL (Railway's PUBLIC Mongo URL), HOUSE_PRIVATE_KEY and RPC_URL from .env.
import 'dotenv/config';
import { ethers } from 'ethers';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { makeChain } from '../src/chain.js';
import { payHandle } from '../src/payout.js';
import { parseHandle } from '../src/handles.js';

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
const db = await connectDb(cfg.mongoUrl, cfg.dbName);
const ctx = { cfg, db, chain: makeChain(cfg), now: () => Date.now(), log: console };
try {
  if (cmd === 'claims') {
    const list = await db.claims.find({ status: 'review' }).sort({ postedAt: 1 }).toArray();
    if (!list.length) console.log('No claims waiting.');
    for (const c of list) {
      const coin = await db.coins.findOne({ key: c.key });
      console.log(`@${c.handle}  code ${c.code}  wallet ${c.wallet}\n  post: ${c.postUrl}\n  owed: ${ethers.formatEther(coin?.owedWei || '0')} ETH\n`);
    }
  } else if (cmd === 'pay') {
    const { key } = parseHandle(args[0]);
    let wallet = args[1], claimId = null;
    if (!wallet) {
      const c = await db.claims.find({ key, status: 'review' }).sort({ postedAt: -1 }).limit(1).next();
      if (!c) throw new Error(`No reviewed claim for @${key}. Pass a wallet: npm run payout -- @${key} <wallet>`);
      wallet = c.wallet; claimId = c._id;
      console.log(`Using claim ${c.code}, post ${c.postUrl}`);
    }
    await payHandle(ctx, { handle: key, wallet, claimId, log: console.log });
  } else throw new Error('Use: npm run claims  or  npm run payout -- @handle [wallet]');
} catch (e) { console.error(e.shortMessage || e.message); process.exitCode = 1; }
finally { await db.client.close(); }
