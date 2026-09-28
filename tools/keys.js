// Prints a fresh operator wallet and vault master key for your .env
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
const k = Keypair.generate();
console.log(`OPERATOR_SECRET=${bs58.encode(k.secretKey)}`);
console.log(`VAULT_MASTER_KEY=${randomBytes(32).toString('hex')}`);
console.log(`\n# operator wallet address (send it ~0.3 SOL for network fees): ${k.publicKey.toBase58()}`);
