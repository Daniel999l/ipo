// Custom contract addresses: keep making random keys until the address ends with the letters we want.
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { generateKeyPairSync } from 'crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { cpus } from 'os';

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function checkSuffix(suffix) {
  if (!suffix) return;
  if (!B58.test(suffix)) throw new Error(`"${suffix}" can't be in a Solana address. Letters 0, O, I and l are not allowed.`);
}

// one key: node's ed25519 is the fastest option in plain JS
function tryKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { pub, privateKey };
}
function toSecret(pub, privateKey) {
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  return Buffer.concat([seed, pub]);
}

// worker loop
if (!isMainThread && workerData?.vanity) {
  const { suffix, ignoreCase } = workerData;
  const want = ignoreCase ? suffix.toLowerCase() : suffix;
  let n = 0;
  for (;;) {
    const { pub, privateKey } = tryKey();
    const addr = bs58.encode(pub);
    const end = addr.slice(-want.length);
    n++;
    if ((ignoreCase ? end.toLowerCase() : end) === want) { parentPort.postMessage({ secret: toSecret(pub, privateKey), tries: n }); n = 0; }
    else if (n % 20000 === 0) { parentPort.postMessage({ tries: n }); n = 0; }
  }
}

// Find one key ending with `suffix`, using `threads` CPU cores. onProgress(totalTries) is optional.
export function grind(suffix, { threads = Math.max(1, cpus().length), ignoreCase = false, onProgress } = {}) {
  checkSuffix(suffix);
  return new Promise((resolve, reject) => {
    const workers = []; let total = 0; let done = false;
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { vanity: true, suffix, ignoreCase } });
      w.on('message', m => {
        total += m.tries || 0;
        if (m.secret && !done) { done = true; workers.forEach(x => x.terminate()); resolve(Keypair.fromSecretKey(Uint8Array.from(m.secret))); }
        else onProgress?.(total);
      });
      w.on('error', e => { if (!done) { done = true; workers.forEach(x => x.terminate()); reject(e); } });
      workers.push(w);
    }
  });
}

// Keeps ready-made mint keys so launches never wait. Uses one CPU core in the background.
// With a database, the keys are saved there (encrypted), so a restart or redeploy doesn't lose them.
export class VanityPool {
  constructor(suffix, size = 10, log, { collection = null, encrypt = null, decrypt = null } = {}) {
    this.suffix = suffix; this.size = size; this.log = log; this.col = collection; this.enc = encrypt; this.dec = decrypt;
    this.keys = []; this.waiters = []; this.stopped = false; this.count = 0;
    if (suffix) checkSuffix(suffix);
  }
  async init() {
    if (this.col) { await this.col.createIndex({ createdAt: 1 }); this.count = await this.col.countDocuments({ suffix: this.suffix }); }
    if (this.count < this.size) this.start();
    return this;
  }
  start() {
    if (!this.suffix || this.worker || this.stopped) return this;
    this.worker = new Worker(new URL(import.meta.url), { workerData: { vanity: true, suffix: this.suffix, ignoreCase: false } });
    this.worker.unref();
    this.worker.on('message', m => { if (m.secret) this._got(Keypair.fromSecretKey(Uint8Array.from(m.secret))).catch(e => this.log?.warn?.('vanity save failed', e.message)); });
    this.worker.on('error', e => this.log?.warn?.('vanity worker stopped', e.message));
    return this;
  }
  async _got(kp) {
    const w = this.waiters.shift();
    if (w) return w(kp);
    if (this.col) {
      await this.col.insertOne({ _id: kp.publicKey.toBase58(), suffix: this.suffix, key: this.enc(kp.secretKey), createdAt: new Date() });
      this.count = await this.col.countDocuments({ suffix: this.suffix });
    } else { this.keys.push(kp); this.count = this.keys.length; }
    if (this.count >= this.size) this.pause();
  }
  pause() { if (this.worker) { this.worker.terminate(); this.worker = null; } }
  async _pop() {
    if (!this.col) return this.keys.shift() || null;
    const doc = await this.col.findOneAndDelete({ suffix: this.suffix }, { sort: { createdAt: 1 } });
    const d = doc && (doc.value !== undefined && doc._id === undefined ? doc.value : doc);
    return d ? this.dec(d.key) : null;
  }
  // returns a key ending in the suffix; waits up to `waitMs` if none is ready, then falls back to a random key
  async take(waitMs = 60000) {
    if (!this.suffix) return Keypair.generate();
    const k = await this._pop();
    this.count = Math.max(0, this.count - (k ? 1 : 0));
    if (this.count < this.size) this.start();
    if (k) return k;
    return new Promise(resolve => {
      const t = setTimeout(() => { const i = this.waiters.indexOf(fn); if (i >= 0) this.waiters.splice(i, 1); resolve(Keypair.generate()); }, waitMs);
      const fn = kp => { clearTimeout(t); resolve(kp); };
      this.waiters.push(fn);
    });
  }
  stop() { this.stopped = true; this.pause(); }
}
