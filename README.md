# IPO

Take any X account public. Search a handle. If nobody has listed it yet, you pay a small fee in ETH and it gets its own coin on Pons (Robinhood Chain). The site shows that coin as the account. Every trade, here or on Pons, counts toward that account, and 80% of the creator fees are saved for the account owner to claim.

## How it works (like you're 10)

1. **Someone lists a handle.** They pay 0.002 ETH to the house wallet. The payment carries a little code so we know which listing it's for.
2. **We check the payment on chain.** Right wallet, right amount, right code, never used before.
3. **The house wallet launches the coin on Pons.** Each handle gets its own piggy bank wallet (a "vault"), made from the house key. The vault is set as the coin's creator fee receiver.
4. **People trade.** On this site (the site builds the trade, your wallet signs it) or on Pons. Every trade pays a 2% creator fee.
5. **Every hour we empty the piggy banks.** The vault sweeps and claims its fees from Pons. 20% goes to the buyback wallet, 80% stays in the vault, owed to the account owner.
6. **The owner claims.** They post a code from their X account, you check it, then you run `npm run payout`.

If a listing can't happen (someone else took the handle first), the payer gets their ETH back automatically. If the server crashes mid-launch, it picks up where it stopped on restart and never launches twice.

When a coin fills its curve (4.2 ETH) it "graduates" to its own Pons pool. The site then sends traders to the Pons page, and fees keep being collected.

## Setup

```
npm install
npm run keys          # makes a brand new house wallet, prints HOUSE_PRIVATE_KEY and its address
```

Put these in `.env` (or Railway variables):

| Name | What |
|---|---|
| `MONGO_URL` | your Mongo connection string |
| `HOUSE_PRIVATE_KEY` | from `npm run keys`. Use a brand new wallet |
| `TOKEN_CA` | the $IPO address on Pons. Leave empty until it's launched; the site says "Launching soon" |

Send the house wallet about **0.003 ETH** on Robinhood Chain. Listers pay for their own launches (one launch costs about 0.0007 ETH right now, listers pay 0.002), so the house only needs a little for gas on refunds and fee collection.

Then:

```
npm run doctor        # checks everything, sends nothing
npm start
```

## Launching $IPO

Add `LAUNCH_PRIVATE_KEY` (the wallet you want to own $IPO and get its fees) to `.env`, then:

```
npm run launch-token                      # dry run, sends nothing
npm run launch-token -- --yes             # launches $IPO on Pons
npm run launch-token -- --yes --buy 0.01  # launches, waits 5 seconds (Pons snipe tax), buys 0.01 ETH
```

If `MONGO_URL` is set it saves the address to the site automatically. Otherwise set `TOKEN_CA` on Railway. The "Buy $IPO" button goes to `https://www.ponsfamily.com/launchpad/<CA>`.

## Paying account owners

```
npm run claims                                   # claims waiting for you, with their X post links
npm run payout -- @handle           # pays the wallet from their checked claim. Never pays twice
npm run payout -- @handle <wallet>  # or pay a wallet you choose
```

## Optional settings

All have defaults. Only set them if you want something different.

`PUBLIC_URL` (https://useipo.up.railway.app), `X_HANDLE` (ipoanyone), `RPC_URL`, `LISTING_FEE_ETH` (0.002), `CREATOR_TAX_BPS` (200 = 2%), `HANDLE_SHARE_BPS` (8000 = 80%), `BUYBACK_WALLET` (empty = house wallet), `COLLECT_EVERY_MINUTES` (60), `MIN_SWEEP_ETH` (0.0005), `RESERVE_MINUTES` (10), `MAX_TRADE_ETH` (20), `CHECK_HANDLES` (true).

## Testing locally

Needs Foundry's `anvil` (`npm i -g @foundry-rs/anvil` works too). Runs against a local copy of Robinhood Chain with the real Pons contracts, so no real money moves.

```
npm test      # listing, bad payments, refunds, crash recovery, buy/sell, fees 80/20, payouts, graduation, claims, pages
npm run sim   # a pretend day with bots, then open http://localhost:3999
```

## Old Solana version

`npm run withdraw-sol` sends everything left in the old Solana operator wallet to your address. It reads `OPERATOR_SECRET` from `.env` (plus your Helius URL as `SOLANA_RPC_URL` if you want it; otherwise it uses the public Solana RPC).
