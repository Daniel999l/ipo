// A pretend day on IPO, on a local copy of Robinhood Chain with the real Pons contracts. Needs anvil (Foundry).
//   npm run sim          then open http://localhost:3999
// Bots take a few accounts public, trade them, one graduates, fees get collected. The site keeps running until Ctrl+C.
import { ethers } from 'ethers';
import { bootStack, wallet, listViaApi, tradeViaApi } from '../test/helpers.js';
import { collectAll, refreshAll } from '../src/collector.js';

const HANDLES = ['naval', 'balajis', 'VitalikButerin', 'pmarca', 'sama', 'paulg', 'levelsio', 'karpathy'];
const port = Number(process.env.SIM_PORT || 3999);
const S = await bootStack({ port, overrides: { profileUrl: 'https://api.fxtwitter.com', avatarUrl: 'https://unavatar.io/x' } });
const log = (...a) => console.log('  ', ...a);
console.log('\nLocal chain and site are up. Running the pretend day...');

const bots = [];
for (let i = 0; i < 6; i++) bots.push(await wallet(S, 50));
const coins = [];
for (const [i, h] of HANDLES.entries()) {
  const { res } = await listViaApi(S, bots[i % bots.length], h);
  if (res.body.status !== 'live') { log('listing failed', h, JSON.stringify(res.body)); continue; }
  coins.push({ handle: h, token: res.body.token, curve: res.body.curve });
  log(`@${h} is public: ${res.body.token}`);
}
await S.fork.skip(10); // past Pons' 3 second snipe tax

// trading: a few rounds so the charts have shape
const rnd = (a, b) => a + Math.random() * (b - a);
for (let round = 0; round < 8; round++) {
  for (const [ci, c] of coins.entries()) {
    const weight = 1 / (ci + 1);
    for (const b of bots.slice(0, 3)) {
      const buy = Math.random() < 0.7;
      try {
        if (buy) await tradeViaApi(S, b, { token: c.token, side: 'buy', eth: +(rnd(0.02, 0.4) * weight * 3).toFixed(4) });
        else await tradeViaApi(S, b, { token: c.token, side: 'sell', percent: Math.round(rnd(10, 40)) });
      } catch {}
    }
  }
  S.clock.t += 20 * 60000;
  await refreshAll(S.ctx);
}
// the top one fills its curve and graduates
const top = coins[0];
const whale = await wallet(S, 20);
const cv = S.ctx.chain.curveAt(top.curve).connect(whale);
for (let i = 0; i < 6 && !(await cv.graduated()); i++) await (await cv.buy(ethers.parseEther('1'), 0, whale.address, { value: ethers.parseEther('1') })).wait();
log(`@${top.handle} graduated: ${await cv.graduated()}`);
await collectAll(S.ctx, { force: true });
await refreshAll(S.ctx);
log('fees collected');
await S.tick();

console.log(`\nOpen http://localhost:${port}  (Ctrl+C to stop)\n`);
setInterval(() => refreshAll(S.ctx).catch(() => {}), 60000);
process.on('SIGINT', async () => { await S.stop(); process.exit(0); });
