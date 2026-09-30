// Checks your setup without sending anything: settings, RPC, house wallet, Mongo, Pons, and a simulated launch.
import 'dotenv/config';
import { ethers } from 'ethers';
import { loadConfig } from '../src/config.js';
import { makeChain, IFACE } from '../src/chain.js';
import { connectDb } from '../src/db.js';

const ok = m => console.log('  ok   ' + m), bad = m => { console.log('  FAIL ' + m); process.exitCode = 1; };
try {
  const cfg = loadConfig(); ok('settings load');
  const chain = makeChain(cfg);
  const net = await chain.provider.getNetwork();
  Number(net.chainId) === cfg.chainId ? ok('RPC is Robinhood Chain') : bad('RPC chain id is ' + net.chainId);
  const bal = await chain.provider.getBalance(chain.house.address);
  ok(`house wallet ${chain.house.address} holds ${ethers.formatEther(bal)} ETH`);
  (await chain.provider.getCode(chain.house.address)) === '0x' ? ok('house wallet has no contract code') : bad('house wallet has contract code attached, use a brand new wallet');
  const db = await connectDb(cfg.mongoUrl, cfg.dbName); ok('Mongo connects'); await db.client.close();
  const [enabled, fee] = await Promise.all([chain.factory.launchEnabled(), chain.factory.launchFee()]);
  enabled ? ok(`Pons launches are open, launch fee ${ethers.formatEther(fee)} ETH`) : bad('Pons launches are paused');
  const econ = await chain.factory.previewLaunchEconomics(0, ethers.ZeroAddress);
  const params = { name: 'doctor 1', symbol: 'DOC', logo: 'ipfs://bafkreihybh3uowlrbxn7tmfso64izsx5uqqpxkkz4pgp6bvuexog6ztioy', description: '', socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: chain.vaultWallet(1).address, creatorTaxBps: cfg.creatorTaxBps, buybackEnabled: false, expectedEconomics: econ, salt: ethers.hexlify(ethers.randomBytes(32)) };
  const data = IFACE.factory.encodeFunctionData('launchToken', [params, 0, ethers.ZeroAddress, []]);
  await chain.provider.send('eth_call', [{ from: chain.house.address, to: cfg.ponsFactory, data, value: ethers.toQuantity(fee) }, 'latest', { [chain.house.address]: { balance: '0x16345785D8A0000' } }]);
  ok('a launch simulates cleanly (nothing sent)');
  const gas = await chain.provider.estimateGas({ from: chain.house.address, to: cfg.ponsFactory, data, value: fee }).catch(() => 3700000n);
  const f = await chain.provider.getFeeData();
  const cost = fee + gas * (f.maxFeePerGas ?? f.gasPrice);
  ok(`one launch costs about ${ethers.formatEther(cost)} ETH right now, listers pay ${cfg.listingFeeEth} ETH`);
  if (cost > cfg.listingFeeWei) bad('LISTING_FEE_ETH is below what a launch costs right now');
} catch (e) { bad(e.shortMessage || e.message); }
