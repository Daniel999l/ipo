// Builds the whole service: database, chain connection, lookup table, API, website and the scheduler.
import express from 'express';
import { Connection } from '@solana/web3.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDb, getSetting, setSetting } from './db.js';
import { apiRouter, avatarRoute } from './api.js';
import { createLaunchLut, extendLut, loadLut } from './lut.js';
import { sweepAll, refreshAll } from './collector.js';
import { recoverListings, lockOpts } from './launch.js';
import { VanityPool } from './vanity.js';
import { refreshProfiles } from './handles.js';
import { encryptSecret, decryptKeypair } from './crypto.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp(cfg, { now = () => Date.now(), log = console } = {}) {
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false });
  const db = await connectDb(cfg.mongoUrl, cfg.dbName);
  const vanity = cfg.mintSuffix ? await new VanityPool(cfg.mintSuffix, cfg.mintPoolSize, log, {
    collection: db.db.collection('vanity'), encrypt: k => encryptSecret(k, cfg.vaultMasterKey), decrypt: b => decryptKeypair(b, cfg.vaultMasterKey),
  }).init() : null;
  // $IPO address: TOKEN_CA if set, otherwise whatever `npm run launch-token` saved in the database
  let caCache = { at: 0, v: cfg.tokenCa || '' };
  const tokenCa = async () => {
    if (cfg.tokenCa) return cfg.tokenCa;
    if (Date.now() - caCache.at > 15000) caCache = { at: Date.now(), v: (await getSetting(db, 'tokenCa')) || '' };
    return caCache.v;
  };
  const ctx = { cfg, conn, db, now, log, vanity, tokenCa };

  // lookup table so a listing fits in one transaction
  let lutAddr = cfg.lutAddress || (await getSetting(db, 'lutAddress'));
  if (!lutAddr) {
    log.info?.('Creating the listing lookup table (one time)...');
    lutAddr = (await createLaunchLut(conn, cfg.operator, lockOpts(cfg))).toBase58();
    await setSetting(db, 'lutAddress', lutAddr);
  }
  try { await extendLut(conn, cfg.operator, lutAddr, [cfg.buyback, cfg.treasury]); }
  catch (e) { log.warn?.('Could not extend the lookup table', e.message); }
  ctx.lut = await loadLut(conn, lutAddr);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use('/api', apiRouter(ctx));
  app.get('/avatar/:handle', (req, res) => avatarRoute(ctx, req, res));
  app.get('/vendor/web3.js', (req, res) => res.sendFile(join(ROOT, 'node_modules/@solana/web3.js/lib/index.iife.min.js')));
  app.get('/media/:id', async (req, res) => {
    const m = await db.db.collection('media').findOne({ _id: req.params.id });
    if (!m) return res.status(404).end();
    res.type(m.type).set('Cache-Control', 'public, max-age=31536000, immutable').send(m.data.buffer ? Buffer.from(m.data.buffer) : m.data);
  });
  app.get('/meta/:id.json', async (req, res) => {
    const m = await db.db.collection('media').findOne({ _id: req.params.id });
    if (!m) return res.status(404).end();
    res.json(m.meta);
  });
  // ipo.site/@handle opens that account's page
  app.get(/^\/@[A-Za-z0-9_]{1,15}\/?$/, (req, res) => res.sendFile(join(ROOT, 'public/account.html')));
  app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(join(ROOT, 'public/404.html')));

  // scheduler: finish interrupted listings, fee sweeps, market stats
  let busy = false, lastSweep = 0, lastRefresh = 0, timer = null;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      await recoverListings(ctx);
      await refreshProfiles(ctx).catch(e => log.warn?.('profiles', e.message));
      if (now() - lastSweep >= cfg.collectEveryMinutes * 60000) { lastSweep = now(); await sweepAll(ctx); }
      if (now() - lastRefresh >= cfg.refreshEveryMinutes * 60000) { lastRefresh = now(); await refreshAll(ctx); }
    } catch (e) { log.error?.('scheduler', e); } finally { busy = false; }
  };
  const startScheduler = () => { tick(); timer = setInterval(tick, cfg.schedulerTickMs); };
  const stop = async () => { clearInterval(timer); vanity?.stop(); await db.client.close(); };
  return { app, ctx, tick, startScheduler, stop };
}
