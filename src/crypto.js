// Handle vault keys are stored encrypted (AES-256-GCM) with VAULT_MASTER_KEY. Never stored in plain text.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { Keypair } from '@solana/web3.js';

export function encryptSecret(secretKey, masterHex) {
  const key = Buffer.from(masterHex, 'hex'); const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(Buffer.from(secretKey)), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptKeypair(blob, masterHex) {
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', Buffer.from(masterHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Keypair.fromSecretKey(Buffer.concat([d.update(enc), d.final()]));
}

export const sha256hex = data => createHash('sha256').update(data).digest('hex');
