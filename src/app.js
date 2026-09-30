// Builds the whole service: database, chain, API, website and the scheduler.
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDb, getSetting } from './db.js';
import { makeChain } from './chain.js';
import { apiRouter, avatarRoute } from './api.js';
import { collectAll, refreshAll } from './collector.js';
import { recoverListings } from './launch.js';
import { refreshProfiles } from './handles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp(cfg, { now = () => Date.now(), log = console, checkChain = true } = {}) {
  const chain = makeChain(cfg);
  if (checkChain) {
    const net = await chain.provider.getNetwork();
    if (Number(net.chainId) !== cfg.chainId) throw new Error('RPC_URL is not Robinhood Chain (got chain id ' + net.chainId + ')');
    // a wallet with code attached (a delegated account) could forward every payment somewhere else
    if ((await chain.provider.getCode(chain.house.address)) !== '0x') throw new Error('HOUSE_PRIVATE_KEY belongs to a wallet with contract code attached. Use a brand new wallet.');
  }
  const db = await connectDb(cfg.mongoUrl, cfg.dbName);
  // $IPO address: TOKEN_CA if set, otherwise whatever was saved in the database
  let caCache = { at: 0, v: cfg.tokenCa || '' };
  const tokenCa = async () => {
    if (cfg.tokenCa) return cfg.tokenCa;
    if (Date.now() - caCache.at > 15000) caCache = { at: Date.now(), v: (await getSetting(db, 'tokenCa')) || '' };
    return caCache.v;
  };
  const ctx = { cfg, chain, db, now, log, tokenCa };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use('/api', apiRouter(ctx));
  app.get('/avatar/:handle', (req, res) => avatarRoute(ctx, req, res));
  app.get('/favicon.ico', (req, res) => res.sendFile(join(ROOT, 'public/coin.png')));
  app.get('/vendor/ethers.js', (req, res) => res.sendFile(join(ROOT, 'node_modules/ethers/dist/ethers.umd.min.js')));
  // useipo.up.railway.app/@handle opens that account's page
  app.get(/^\/@[A-Za-z0-9_]{1,15}\/?$/, (req, res) => res.sendFile(join(ROOT, 'public/account.html')));
  app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(join(ROOT, 'public/404.html')));

  // scheduler: finish paid listings, profiles, market data, fee collection
  let busy = false, lastCollect = 0, lastRefresh = 0, timer = null;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      await recoverListings(ctx);
      await refreshProfiles(ctx).catch(e => log.warn?.('profiles', e.message));
      if (now() - lastRefresh >= cfg.refreshEveryMinutes * 60000) { lastRefresh = now(); await refreshAll(ctx).catch(e => log.warn?.('markets', e.message)); }
      if (now() - lastCollect >= cfg.collectEveryMinutes * 60000) { lastCollect = now(); await collectAll(ctx); }
    } catch (e) { log.error?.('scheduler', e); } finally { busy = false; }
  };
  const startScheduler = () => { tick(); timer = setInterval(tick, cfg.schedulerTickMs); };
  const stop = async () => { clearInterval(timer); await db.client.close(); };
  return { app, ctx, tick, startScheduler, stop };
}
