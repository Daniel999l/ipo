// The $IPO launch tools: custom address + launch on (local, real-program) pump.fun from your own wallet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { startValidator } from '../sim/validator.js';
import { grind } from '../src/vanity.js';
import { launchToken } from '../tools/launch-token.js';
import { curveState } from '../src/pump.js';
import { confirmSig } from '../src/tx.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

let v;
before(async () => { v = await startValidator({ rpcPort: 8899 }); });
after(async () => { await v?.stop(); });

test('grind finds an address with the wanted ending', async () => {
  const kp = await grind('ab', { threads: 2 });
  assert.ok(kp.publicKey.toBase58().endsWith('ab'));
  assert.throws(() => grind('l0ck'), /can't be in a Solana address/);
});

test('launch-token: dry run simulates, --yes launches with the custom address and your wallet as creator', async () => {
  const mint = await grind('ok', { threads: 2 });
  const wallet = Keypair.generate();
  await confirmSig(v.conn, await v.conn.requestAirdrop(wallet.publicKey, 10e9));
  const base = { rpc: v.url, mint, wallet, name: 'IPO', symbol: 'IPO', uri: 'https://example.com/ipo.json', devBuySol: 1, log: () => {} };
  const dry = await launchToken({ ...base, send: false });
  assert.equal(dry.sent, false);
  assert.equal(await v.conn.getAccountInfo(mint.publicKey), null, 'dry run launched nothing');
  const mongo = await MongoMemoryServer.create();
  const r = await launchToken({ ...base, send: true, saveTo: { mongoUrl: mongo.getUri(), dbName: 'ipo' } });
  const c = new MongoClient(mongo.getUri()); await c.connect();
  assert.equal((await c.db('ipo').collection('settings').findOne({ _id: 'tokenCa' })).value, r.mint, 'address saved for the site');
  await c.close(); await mongo.stop();
  assert.ok(r.sent && r.mint.endsWith('ok'));
  const cs = await curveState(v.conn, r.mint);
  assert.equal(cs.creator, wallet.publicKey.toBase58(), 'creator fees go to your wallet');
  const bal = await v.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(r.mint), wallet.publicKey, false, TOKEN_2022_PROGRAM_ID));
  assert.ok(BigInt(bal.value.amount) > 0n, 'first buy landed');
});
