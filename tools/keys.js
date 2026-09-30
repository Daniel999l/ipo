// Prints a brand new house wallet for your .env
import { ethers } from 'ethers';
const w = ethers.Wallet.createRandom();
console.log(`HOUSE_PRIVATE_KEY=${w.privateKey}`);
console.log(`\n# house wallet address: ${w.address}`);
console.log('# send it a little ETH on Robinhood Chain (0.003 is plenty to start). Listers pay for their own launches.');
