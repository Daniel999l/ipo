// Transaction helpers: build (legacy or v0 with a lookup table), send, and confirm by polling.
import { ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function budgetIxs({ units = 400000, microLamports = 0 } = {}) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return ixs;
}

export async function buildV0(conn, { payer, ixs, luts = [], blockhash }) {
  const bh = blockhash || (await conn.getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(luts);
  return { tx: new VersionedTransaction(msg), blockhash: bh };
}

export async function confirmSig(conn, sig, { lastValidBlockHeight, timeoutMs = 90000, raw } = {}) {
  const t0 = Date.now(); let lastSend = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (raw && Date.now() - lastSend > 2000) { lastSend = Date.now(); conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); }
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st) {
      if (st.err) { const e = new Error('Transaction failed: ' + JSON.stringify(st.err)); e.txErr = st.err; e.signature = sig; throw e; }
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return sig;
    }
    if (lastValidBlockHeight) { const h = await conn.getBlockHeight('confirmed'); if (h > lastValidBlockHeight) throw new Error('Transaction expired: ' + sig); }
    await sleep(400);
  }
  throw new Error('Confirmation timeout: ' + sig);
}

// Sign with local keypairs and send. Works for legacy and v0.
export async function sendIxs(conn, { payer, ixs, signers, luts = [], units = 400000, microLamports = 0, skipPreflight = false }) {
  const all = [...budgetIxs({ units, microLamports }), ...ixs];
  const { tx, blockhash } = await buildV0(conn, { payer: payer.publicKey, ixs: all, luts });
  tx.sign([payer, ...signers.filter(s => !s.publicKey.equals(payer.publicKey))]);
  return sendSigned(conn, tx, blockhash, { skipPreflight });
}

export async function sendSigned(conn, tx, blockhash, { skipPreflight = false } = {}) {
  const raw = tx.serialize();
  let sig;
  try { sig = await conn.sendRawTransaction(raw, { skipPreflight, maxRetries: 3, preflightCommitment: 'confirmed' }); }
  catch (e) { const err = new Error(e.message); err.logs = e.logs || e.transactionLogs; throw err; }
  return confirmSig(conn, sig, { lastValidBlockHeight: blockhash?.lastValidBlockHeight, raw });
}
