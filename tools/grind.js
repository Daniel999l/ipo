// Find a contract address that ends with the letters you want, using every CPU core.
//   npm run grind -- ipo
//   npm run grind -- ipo --ignore-case     (faster, also accepts iPo-style mixes base58 allows)
// Saves the key to keys/mint-<address>.json. Keep that file private until you launch.
import { grind, checkSuffix } from '../src/vanity.js';
import { mkdirSync, writeFileSync } from 'fs';
import { cpus } from 'os';

const args = process.argv.slice(2);
const suffix = args.find(a => !a.startsWith('--')) || 'ipo';
const ignoreCase = args.includes('--ignore-case');
checkSuffix(suffix);
const threads = cpus().length;
const expected = Math.pow(58, suffix.length) / (ignoreCase ? Math.pow(2, [...suffix].filter(c => /[a-zA-Z]/.test(c)).length) : 1);
console.log(`Looking for an address ending in "${suffix}"${ignoreCase ? ' (any case)' : ''} on ${threads} cores. Expect about ${Math.round(expected).toLocaleString()} tries.`);
const t0 = Date.now();
let last = 0;
const kp = await grind(suffix, { threads, ignoreCase, onProgress: n => {
  if (Date.now() - last < 2000) return; last = Date.now();
  const s = (Date.now() - t0) / 1000; process.stdout.write(`\r${n.toLocaleString()} tries, ${Math.round(n / s).toLocaleString()}/s, ${s.toFixed(0)}s   `);
} });
const addr = kp.publicKey.toBase58();
mkdirSync('keys', { recursive: true });
const file = `keys/mint-${addr}.json`;
writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
console.log(`\n\nFound: ${addr}\nSaved: ${file}\nTook ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
