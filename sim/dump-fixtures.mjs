// Dumps the real pump.fun programs + global accounts from Solana mainnet into sim/fixtures,
// so the local validator runs the exact same on-chain code.
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import sdk from '../src/pumpsdk.js';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, FEE_PROGRAM_GLOBAL_PDA, AMM_GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA,
  AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA, QUOTE_CONTROL_PDA, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MAYHEM_PROGRAM_ID,
  getGlobalParamsPda, getSolVaultPda } = sdk;

const RPC = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const dir = new URL('./fixtures/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });

const want = new Map();
const add = (pk, why) => want.set(new PublicKey(pk).toBase58(), why);
add(GLOBAL_PDA, 'pump global'); add(PUMP_FEE_CONFIG_PDA, 'pump fee config'); add(FEE_PROGRAM_GLOBAL_PDA, 'fee program global');
add(AMM_GLOBAL_PDA, 'amm global pda (sdk)');
const AMM_GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP_AMM_PROGRAM_ID)[0];
add(AMM_GLOBAL_CONFIG, 'amm global config'); add(GLOBAL_VOLUME_ACCUMULATOR_PDA, 'volume acc'); add(AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA, 'amm volume acc');
add(QUOTE_CONTROL_PDA, 'quote control');
try { add(getGlobalParamsPda(), 'mayhem global params'); add(getSolVaultPda(), 'mayhem sol vault'); } catch (e) { console.log('mayhem pdas', e.message); }
// AMM fee config lives under the fee program, seeded with the AMM program id
add(PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PUMP_AMM_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID)[0], 'amm fee config');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function info(pk) { for (let i = 0; i < 6; i++) { try { return await conn.getAccountInfo(new PublicKey(pk)); } catch (e) { await sleep(1500 * (i + 1)); } } throw new Error('fetch failed ' + pk); }

// fee recipients from pump global
const g = PUMP_SDK.decodeGlobal(await info(GLOBAL_PDA));
const recips = [g.feeRecipient, ...(g.feeRecipients || []), g.reservedFeeRecipient, ...(g.reservedFeeRecipients || []), ...(g.buybackFeeRecipients || [])].filter(Boolean);
for (const r of recips) { add(r, 'pump fee recipient'); add(getAssociatedTokenAddressSync(NATIVE_MINT, r, true), 'pump fee recipient wsol ata'); }
// protocol fee recipients from AMM global config
const ammProg = sdk.getPumpAmmProgram(conn);
const ammGlobal = await ammProg.account.globalConfig.fetch(AMM_GLOBAL_CONFIG);
for (const r of [...(ammGlobal.protocolFeeRecipients || [])].filter(x => !x.equals(PublicKey.default))) {
  add(r, 'amm protocol fee recipient'); add(getAssociatedTokenAddressSync(NATIVE_MINT, r, true), 'amm protocol fee recipient wsol ata');
}
console.log('global withdraw authority', g.withdrawAuthority?.toBase58?.());

const manifest = { accounts: [], programs: [] };
for (const [pk, why] of want) {
  const a = await info(pk);
  if (!a) { console.log('missing (skipped)', pk, why); continue; }
  const file = `${pk}.json`;
  writeFileSync(dir + file, JSON.stringify({ pubkey: pk, account: { lamports: a.lamports, data: [a.data.toString('base64'), 'base64'], owner: a.owner.toBase58(), executable: a.executable, rentEpoch: 0, space: a.data.length } }));
  manifest.accounts.push({ pubkey: pk, file, why });
  await sleep(150);
}
for (const [id, name] of [[PUMP_PROGRAM_ID, 'pump'], [PUMP_AMM_PROGRAM_ID, 'pump_amm'], [PUMP_FEE_PROGRAM_ID, 'pump_fees'], [MAYHEM_PROGRAM_ID, 'mayhem']]) {
  const out = `${dir}${name}.so`;
  execSync(`solana program dump -u ${RPC} ${id.toBase58()} ${out}`, { stdio: 'inherit' });
  manifest.programs.push({ programId: id.toBase58(), file: `${name}.so`, name });
}
writeFileSync(dir + 'manifest.json', JSON.stringify(manifest, null, 1));
console.log('accounts', manifest.accounts.length, 'programs', manifest.programs.length);
