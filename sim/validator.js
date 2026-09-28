// Starts a local Solana validator loaded with the real pump.fun programs and global accounts
// (dumped from mainnet by sim/dump-fixtures.mjs). Used by the test suite and `npm run sim`.
import { spawn, execSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Connection } from '@solana/web3.js';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const HOME_BIN = join(process.env.HOME || process.env.USERPROFILE || '', '.local/share/solana/install/active_release/bin');
const BIN = process.env.SOLANA_BIN || (existsSync(HOME_BIN) ? HOME_BIN : '');

export async function startValidator({ rpcPort = 8899, overrides = [], quiet = true } = {}) {
  const manifest = JSON.parse(readFileSync(FIX + 'manifest.json', 'utf8'));
  const ledger = mkdtempSync(join(tmpdir(), 'potlock-ledger-'));
  const args = ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(rpcPort), '--faucet-port', String(rpcPort + 1100)];
  const overridden = new Set(overrides.map(o => o.pubkey));
  for (const a of manifest.accounts) if (!overridden.has(a.pubkey)) args.push('--account', a.pubkey, FIX + a.file);
  for (const o of overrides) { const f = join(ledger, '..', `ovr-${o.pubkey}.json`); writeFileSync(f, JSON.stringify(o.json)); args.push('--account', o.pubkey, f); }
  for (const p of manifest.programs) args.push('--upgradeable-program', p.programId, FIX + p.file, 'none');
  const proc = spawn(BIN ? join(BIN, 'solana-test-validator') : 'solana-test-validator', args, { stdio: quiet ? 'ignore' : 'inherit' });
  const url = `http://127.0.0.1:${rpcPort}`;
  const conn = new Connection(url, 'confirmed');
  for (let i = 0; i < 120; i++) {
    try { const s = await conn.getSlot(); if (s > 2) break; } catch {}
    await new Promise(r => setTimeout(r, 500));
    if (proc.exitCode !== null) throw new Error('validator exited ' + proc.exitCode);
  }
  return { url, conn, proc, ledger, stop: () => new Promise(r => { proc.once('exit', r); proc.kill('SIGINT'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 5000); }) };
}

export function fixtureAccount(pubkey) {
  return JSON.parse(readFileSync(FIX + pubkey + '.json', 'utf8'));
}

if (process.argv[1] && process.argv[1].endsWith('validator.js')) {
  const v = await startValidator({ quiet: false });
  console.log('Local pump.fun validator running at', v.url);
}
