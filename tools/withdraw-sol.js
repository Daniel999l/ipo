// Sends everything the Solana version of IPO holds back to one wallet:
//   1. closes the listing lookup table(s) the operator wallet created (gets the ~0.013 SOL deposit back)
//   2. empties every handle vault (only if MONGO_URL and VAULT_MASTER_KEY are in .env)
//   3. sends the operator wallet's whole balance
//
//   node tools/withdraw-sol.js                  sends to 98xiCQqSHi9EeXTYMmS6T9At6quFweQS5huD5tFnj36L
//   node tools/withdraw-sol.js <other address>  sends somewhere else
//
// Reads OPERATOR_SECRET and SOLANA_RPC_URL (or a Solana RPC_URL) (and optionally MONGO_URL, DB_NAME, VAULT_MASTER_KEY) from .env.
// A lookup table has to be switched off and then wait about 4 minutes before it can be closed, so the script waits.
import 'dotenv/config';
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const DEFAULT_TO = '98xiCQqSHi9EeXTYMmS6T9At6quFweQS5huD5tFnj36L';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sol = l => (Number(l) / LAMPORTS_PER_SOL).toFixed(6) + ' SOL';

export async function withdrawAll({ rpc, operator, to, vaults = [], log = console.log, waitMs = 8 * 60000, pollMs = 15000 }) {
  const conn = new Connection(rpc, 'confirmed');
  const dest = new PublicKey(to);

  async function send(payer, ixs, signers = []) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer, ...signers]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (r.value.err) throw new Error('transaction failed: ' + JSON.stringify(r.value.err));
    return sig;
  }

  log(`Operator wallet: ${operator.publicKey.toBase58()} (${sol(await conn.getBalance(operator.publicKey))})`);
  log(`Sending everything to: ${dest.toBase58()}\n`);

  // 1. lookup tables owned by the operator (authority sits at byte 22 of the account)
  const tables = await conn.getProgramAccounts(AddressLookupTableProgram.programId, { filters: [{ memcmp: { offset: 22, bytes: operator.publicKey.toBase58() } }] });
  if (!tables.length) log('No lookup tables to close.');
  for (const t of tables) {
    const addr = t.pubkey;
    log(`Lookup table ${addr.toBase58()} holds ${sol(t.account.lamports)}`);
    const st = (await conn.getAddressLookupTable(addr)).value;
    if (st?.isActive()) {
      await send(operator, [AddressLookupTableProgram.deactivateLookupTable({ lookupTable: addr, authority: operator.publicKey })]);
      log('  switched off, waiting until it can be closed (about 4 minutes)...');
    }
    const t0 = Date.now();
    for (;;) {
      try {
        const sig = await send(operator, [AddressLookupTableProgram.closeLookupTable({ lookupTable: addr, authority: operator.publicKey, recipient: dest })]);
        log(`  closed, deposit sent: ${sig}`);
        break;
      } catch (e) {
        if (Date.now() - t0 > waitMs) { log(`  still not closable, run the script again in a few minutes (${e.message.slice(0, 80)})`); break; }
        await sleep(pollMs);
      }
    }
  }

  // 2. handle vaults (the operator pays the network fee, the vault sends its whole balance)
  for (const v of vaults) {
    const bal = await conn.getBalance(v.kp.publicKey);
    if (bal <= 0) continue;
    const sig = await send(operator, [SystemProgram.transfer({ fromPubkey: v.kp.publicKey, toPubkey: dest, lamports: bal })], [v.kp]);
    log(`Vault for @${v.handle}: sent ${sol(bal)} (${sig})`);
  }

  // 3. the operator's own balance, minus the network fee for this last transfer
  const bal = await conn.getBalance(operator.publicKey);
  const fee = 5000;
  if (bal > fee) {
    const sig = await send(operator, [SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: dest, lamports: bal - fee })]);
    log(`\nOperator wallet: sent ${sol(bal - fee)} (${sig})`);
  } else log('\nOperator wallet is empty.');
  log(`Done. ${dest.toBase58()} now holds ${sol(await conn.getBalance(dest))}`);
}

async function loadVaults() {
  if (!process.env.MONGO_URL || !process.env.VAULT_MASTER_KEY) return [];
  const [{ MongoClient }, { decryptKeypair }] = await Promise.all([import('mongodb'), import('../src/crypto.js')]);
  const client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const coins = await client.db(process.env.DB_NAME || 'ipo').collection('coins').find({ vaultKey: { $exists: true } }).toArray();
    return coins.map(c => ({ handle: c.handle, kp: decryptKeypair(c.vaultKey, process.env.VAULT_MASTER_KEY) }));
  } catch (e) { console.log('Could not read vaults from the database, skipping them:', e.message); return []; }
  finally { await client.close().catch(() => {}); }
}

if (process.argv[1]?.endsWith('withdraw-sol.js')) {
  try {
    if (!process.env.OPERATOR_SECRET) throw new Error('Put OPERATOR_SECRET in .env first.');
    const operator = Keypair.fromSecretKey(bs58.decode(process.env.OPERATOR_SECRET.trim()));
    const to = process.argv[2] || DEFAULT_TO;
    await withdrawAll({ rpc: process.env.SOLANA_RPC_URL || (/solana|helius/i.test(process.env.RPC_URL || '') ? process.env.RPC_URL : 'https://api.mainnet-beta.solana.com'), operator, to, vaults: await loadVaults() });
    process.exit(0);
  } catch (e) { console.error('\n' + e.message); process.exit(1); }
}
