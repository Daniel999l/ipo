import { MongoClient } from 'mongodb';

export async function connectDb(url, dbName) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  const col = {
    coins: db.collection('coins'),             // one per listed handle
    launches: db.collection('launches'),       // listings waiting for a signature (also holds the handle while signing)
    collections: db.collection('collections'), // fee sweeps into vaults
    ticks: db.collection('ticks'),             // chart points
    claims: db.collection('claims'),           // account owners asking for their fees
    payouts: db.collection('payouts'),         // fees sent to account owners
    avatars: db.collection('avatars'),         // cached profile pictures
    profiles: db.collection('profiles'),       // cached X profiles
    settings: db.collection('settings'),
  };
  await Promise.all([
    col.coins.createIndex({ mint: 1 }, { unique: true }),
    col.coins.createIndex({ key: 1 }, { unique: true }),
    col.coins.createIndex({ status: 1, createdAt: -1 }),
    col.coins.createIndex({ status: 1, mcapLamports: -1 }),
    col.launches.createIndex({ key: 1 }, { unique: true }),
    col.launches.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    col.ticks.createIndex({ mint: 1, t: 1 }),
    col.ticks.createIndex({ t: 1 }, { expireAfterSeconds: 8 * 86400 }),
    col.claims.createIndex({ key: 1, createdAt: -1 }),
    col.payouts.createIndex({ key: 1, createdAt: -1 }),
  ]);
  return { client, db, ...col };
}

export async function getSetting(db, key) { return (await db.settings.findOne({ _id: key }))?.value; }
export async function setSetting(db, key, value) { await db.settings.updateOne({ _id: key }, { $set: { value } }, { upsert: true }); }
