import { MongoClient } from 'mongodb';

export async function connectDb(url, dbName) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  const col = {
    coins: db.collection('coins'),             // one per listed handle
    listings: db.collection('listings'),       // a listing from "pay" to "live" (holds the handle while it is in progress)
    fees: db.collection('fees'),               // every sweep, claim and buyback transfer, saved before it is sent
    ticks: db.collection('ticks'),             // chart points
    claims: db.collection('claims'),           // account owners asking for their fees
    payouts: db.collection('payouts'),         // fees sent to account owners
    avatars: db.collection('avatars'),
    profiles: db.collection('profiles'),
    counters: db.collection('counters'),
    settings: db.collection('settings'),
  };
  await Promise.all([
    col.coins.createIndex({ token: 1 }, { unique: true }),
    col.coins.createIndex({ key: 1 }, { unique: true }),
    col.coins.createIndex({ vaultIndex: 1 }, { unique: true }),
    col.coins.createIndex({ status: 1, createdAt: -1 }),
    col.coins.createIndex({ status: 1, mcapUsd: -1 }),
    col.listings.createIndex({ hold: 1 }, { unique: true, partialFilterExpression: { hold: { $exists: true } } }),
    col.listings.createIndex({ payTx: 1 }, { unique: true, partialFilterExpression: { payTx: { $exists: true } } }),
    col.listings.createIndex({ status: 1 }),
    col.ticks.createIndex({ token: 1, t: 1 }),
    col.ticks.createIndex({ t: 1 }, { expireAfterSeconds: 8 * 86400 }),
    col.claims.createIndex({ key: 1, createdAt: -1 }),
    col.payouts.createIndex({ key: 1, createdAt: -1 }),
    col.fees.createIndex({ token: 1, at: -1 }),
  ]);
  return { client, db, ...col };
}

export async function nextSeq(db, name) {
  const r = await db.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const doc = r && r.value !== undefined && r._id === undefined ? r.value : r;
  return doc.seq;
}
export async function getSetting(db, key) { return (await db.settings.findOne({ _id: key }))?.value; }
export async function setSetting(db, key, value) { await db.settings.updateOne({ _id: key }, { $set: { value } }, { upsert: true }); }
