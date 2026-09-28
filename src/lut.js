// Address lookup table holding the pump.fun accounts every launch uses.
// Lets create + fee lock fit in ONE transaction, so a coin is never live without its pot lock.
import { AddressLookupTableProgram, Keypair, PublicKey } from '@solana/web3.js';
import { sendIxs } from './tx.js';
import { launchInstructions, OnlinePumpSdk, NATIVE_MINT } from './pump.js';
import { devBuyIxs } from './launch.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function staticLaunchKeys(conn, { buyback, potBps = 8000 } = {}) {
  const mk = async () => {
    const [a, b, c] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const ixs = [...await launchInstructions({ mint: a.publicKey, creator: b.publicKey, pot: c.publicKey, name: 'x', symbol: 'x', uri: 'x', buyback, potBps }),
      ...await devBuyIxs(conn, { mint: a.publicKey, user: b.publicKey, lamports: 1000000n })];
    const keys = new Set(); for (const ix of ixs) { keys.add(ix.programId.toBase58()); ix.keys.forEach(k => keys.add(k.pubkey.toBase58())); }
    return keys;
  };
  const [k1, k2] = [await mk(), await mk()];
  const keys = new Set([...k1].filter(k => k2.has(k)));
  // every pump fee recipient (the buy picks one at random) and its wrapped-SOL account
  const g = await new OnlinePumpSdk(conn).fetchGlobal();
  for (const r of [g.feeRecipient, ...(g.feeRecipients || []), ...(g.buybackFeeRecipients || [])].filter(Boolean)) {
    keys.add(r.toBase58()); keys.add(getAssociatedTokenAddressSync(NATIVE_MINT, r, true).toBase58());
  }
  return [...keys].map(k => new PublicKey(k));
}

export async function createLaunchLut(conn, operator, opts) {
  return createLut(conn, operator, await staticLaunchKeys(conn, opts));
}

// adds any missing addresses to a table we own (e.g. the buyback wallet after the fee split changed)
export async function extendLut(conn, operator, address, keys) {
  const cur = await loadLut(conn, address);
  const have = new Set(cur.state.addresses.map(a => a.toBase58()));
  const add = keys.filter(k => !have.has(k.toBase58()));
  if (!add.length || !cur.state.authority?.equals(operator.publicKey)) return 0;
  for (let i = 0; i < add.length; i += 20) {
    await sendIxs(conn, { payer: operator, ixs: [AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(address), authority: operator.publicKey, payer: operator.publicKey, addresses: add.slice(i, i + 20) })], signers: [] });
  }
  const s0 = await conn.getSlot('confirmed'); while ((await conn.getSlot('confirmed')) <= s0 + 1) await sleep(300);
  return add.length;
}

// Accounts that are the same in two builds made with different random keys (so they're safe to share in a table).
export async function commonKeys(build) {
  const collect = async () => { const s = new Set(); for (const ix of await build()) { s.add(ix.programId.toBase58()); ix.keys.forEach(k => s.add(k.pubkey.toBase58())); } return s; };
  const [a, b] = [await collect(), await collect()];
  return [...a].filter(k => b.has(k)).map(k => new PublicKey(k));
}

export async function createLut(conn, operator, keys) {
  let slot = await conn.getSlot('finalized');
  while (slot < 1) { await sleep(400); slot = await conn.getSlot('finalized'); }
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: operator.publicKey, payer: operator.publicKey, recentSlot: slot });
  await sendIxs(conn, { payer: operator, ixs: [createIx], signers: [] });
  for (let i = 0; i < keys.length; i += 20) {
    await sendIxs(conn, { payer: operator, ixs: [AddressLookupTableProgram.extendLookupTable({ lookupTable: lut, authority: operator.publicKey, payer: operator.publicKey, addresses: keys.slice(i, i + 20) })], signers: [] });
  }
  // a new table is usable from the next slot
  const s0 = await conn.getSlot('confirmed'); while ((await conn.getSlot('confirmed')) <= s0 + 1) await sleep(300);
  return lut;
}

export async function loadLut(conn, address) {
  const r = await conn.getAddressLookupTable(new PublicKey(address));
  if (!r.value) throw new Error('Lookup table not found: ' + address);
  return r.value;
}
