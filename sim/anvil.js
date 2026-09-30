// Local copy of Robinhood Chain (a fork of mainnet) with the real Pons contracts. Used by the tests and `npm run sim`.
// Needs Foundry's anvil on your PATH (or ANVIL_BIN).
import { spawn } from 'child_process';
import { ethers } from 'ethers';

export async function startFork({ port = 8547, forkUrl = process.env.FORK_URL || 'https://rpc.mainnet.chain.robinhood.com' } = {}) {
  const bin = process.env.ANVIL_BIN || 'anvil';
  const proc = spawn(bin, ['--fork-url', forkUrl, '--chain-id', '4663', '--port', String(port), '--silent', '--compute-units-per-second', '30', '--retries', '30', '--fork-retry-backoff', '2000', '--timeout', '60000'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const provider = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  for (let i = 0; i < 90; i++) {
    try { await provider.getBlockNumber(); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
    if (proc.exitCode !== null) throw new Error('anvil exited, is it installed? (' + bin + ')');
  }
  const fund = (addr, eth) => provider.send('anvil_setBalance', [addr, ethers.toBeHex(ethers.parseEther(String(eth)))]);
  const skip = async secs => { await provider.send('evm_increaseTime', [secs]); await provider.send('evm_mine', []); };
  const stop = () => new Promise(r => { proc.once('exit', r); proc.kill('SIGINT'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 4000); });
  return { url, provider, fund, skip, stop };
}
