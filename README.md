# IPO

Take any X account public. Search a handle; if nobody has listed it yet, you pay a small fee and it gets its own coin on pump.fun. The site shows that coin as the account. Every trade, on this site or anywhere else, counts toward that account, and a share of the creator fees is saved for the account owner to claim.

## How it works (short)

1. **List.** The site builds one transaction that the lister signs in their wallet: pay the listing fee to the treasury, fund a new vault wallet for the handle, create the coin on pump.fun (`create_v2`), turn on pump.fun fee sharing, and lock the creator fees 80% to the handle vault and 20% to the buyback wallet. Locking removes the admin, so nobody (us included) can ever change where the fees go. It all lands together or not at all. A tiny first buy (0.00001 SOL) follows in the same wallet prompt.
2. **The coin is just a reference.** On pump.fun each coin gets a plain random name and ticker like `kqrnst 1042` / `X7K2M` and an address ending in `ipo`. The site maps that address to the handle and shows the handle, its picture, chart and trades.
3. **One handle, one coin.** A handle is held for the wallet that is signing, so two people can't list it at the same time, and it can only be listed once (any letter case).
4. **Trade.** Buy and sell buttons build pump.fun transactions for the user's own wallet to sign and send. Works on the bonding curve and after graduation on PumpSwap. The site never holds anyone's money.
5. **Fees.** Every few minutes the server calls pump.fun's permissionless `distribute_creator_fees` for every coin, which moves each coin's fees into its own handle vault (and the 20% to buybacks). Every handle's earnings are exact, not estimated.
6. **Claim.** The owner goes to `/claim`, gives a wallet, posts a short code from the account and pastes the link. You check it and pay by hand:

```bash
npm run claims                  # claims waiting for review, with the post link and the amount waiting
npm run payout -- @handle       # pays the newest reviewed claim's wallet
npm run payout -- @handle <wallet>
```

The payout signature is saved before sending, so running it twice never pays twice.

Your revenue: the listing fee on every account, 20% of every coin's creator fees (buyback wallet), and the creator fees of $IPO itself.

## Run it for real

```bash
npm install
npm run keys          # prints OPERATOR_SECRET and VAULT_MASTER_KEY, and the operator wallet address
cp .env.example .env  # fill the 4 values
npm start
```

| Required | What it is |
|---|---|
| `MONGO_URL` | MongoDB connection string (Railway Mongo works) |
| `OPERATOR_SECRET` | Wallet that pays network fees for sweeps and payouts. 0.02 SOL is enough to start: about 0.013 goes to the one-time lookup table, each sweep or payout costs about 0.000013. It also gets the 20% buyback share by default, so it refills itself as people trade. |
| `VAULT_MASTER_KEY` | 64 hex chars. Encrypts every handle vault key. **Back it up. Lose it and the vaults are locked forever.** |
| `TOKEN_CA` | The $IPO contract address. Defaults to `FXihEHahkX2atHPKbNaGhgCQq7bmfdV7V5grozt3pump`, so it can stay empty. |

On first start the server creates a small address lookup table (about 0.013 SOL, a one-time deposit the table holds, not a fee) and saves it in the database.

A listing costs the lister the listing fee plus about 0.021 SOL of pump.fun setup (rent, network fees, first buy). Measured on the local pump.fun copy: 0.0715 SOL total with the default 0.05 SOL fee.

### Optional overrides (all have defaults)

| Setting | Default | Notes |
|---|---|---|
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | **Use a paid RPC in production** (Helius, Triton, QuickNode). |
| `PUBLIC_URL` | `https://useipo.up.railway.app` | Site address. Each coin's website link on pump.fun points to its page here. |
| `PORT` | `3000` | |
| `DB_NAME` | `ipo` | |
| `X_HANDLE` | `ipoanyone` | Footer and "Follow on X" links |
| `LISTING_FEE_SOL` | `0.05` | Paid to the treasury in the listing transaction |
| `DEV_BUY_SOL` | `0.00001` | Tiny first buy after the coin is created |
| `HANDLE_SHARE_BPS` | `8000` | Handle vault's share of creator fees (8000 = 80%). Only affects coins listed after a change. |
| `TREASURY_WALLET` | operator wallet | Gets listing fees |
| `BUYBACK_WALLET` | operator wallet | Gets the other 20% of creator fees. A brand-new wallet needs about 0.002 SOL first. |
| `COIN_IMAGE` | `public/coin.png` | Image every listed coin uses on pump.fun |
| `PROFILE_URL` | `https://api.fxtwitter.com` | Real X name, bio, followers, verified badge and picture for every account (free public API, cached 12 hours, listed accounts refreshed in the background). Empty = off. |
| `AVATAR_URL` | `https://unavatar.io/x` | Backup profile pictures if the profile service is down. Empty = off (initials only). |
| `CHECK_HANDLES` | `true` | Refuse handles that don't exist on X |
| `MINT_SUFFIX` | `ipo` | Ending for every coin's address. Empty turns it off. |
| `MINT_POOL_SIZE` | `10` | Ready-made addresses kept in the database |
| `LIST_RATE_PER_HOUR` | `20` | Per IP |
| `RESERVE_SECONDS` | `150` | How long a handle is held while someone signs |
| `COLLECT_EVERY_MINUTES` | `10` | How often fees are swept into vaults |
| `MIN_COLLECT_LAMPORTS` | `5000000` | Skip sweeps smaller than this |
| `REFRESH_EVERY_MINUTES` | `1` | Market values and chart points |
| `MARKET_URL` | DexScreener tokens API | 24h volume and trades. Empty = off. |
| `MAX_TRADE_SOL` | `100` | Biggest buy the site builds |
| `PRIORITY_MICROLAMPORTS` | `20000` | Priority fee on transactions |
| `METADATA_MODE` | `pump` | `pump` uploads to pump.fun IPFS. `self` serves from this server. |
| `LUT_ADDRESS` | empty | Created automatically |

## Launch $IPO with an address ending in `ipo`

Do this once, on your own computer. Put your launch wallet's private key in `.env` as `LAUNCH_WALLET_SECRET` (and your `RPC_URL`). Send that wallet about 0.25 SOL. Capital `I` and `O` can't be in a Solana address, so the ending is lowercase `ipo`.

```bash
npm run grind -- ipo             # finds an address ending in ipo, saves it in keys/ (git-ignored)
npm run launch-token             # checks everything and simulates, launches nothing
npm run launch-token -- --yes    # launches for real, with a 0.1 SOL first buy
```

Uses `public/ipo-token.png`. If your laptop `.env` has `MONGO_URL` (Railway's **public** Mongo URL), the address is saved to the site database and the live site shows it within a minute. Otherwise set `TOKEN_CA` on Railway.

## Test it against pump.fun (local copy)

The tests and the simulator run a local Solana validator loaded with the **real pump.fun programs and accounts copied from mainnet**. Nothing is mocked. Needs the Solana CLI (`solana-test-validator`); on Windows run these inside WSL.

```bash
npm test          # full end-to-end suite
npm run sim       # the whole site on http://localhost:3000 with bots listing accounts and trading
```

What `npm test` proves:

- Listing is one transaction: the treasury gets exactly the fee, fees are locked 80% to the handle vault and 20% to buybacks with the admin removed, the first buy lands, the address has the custom ending, the on-chain name is plain.
- A handle lists once in any letter case, is held while someone signs, and bad handles are refused.
- A changed or unsigned listing transaction is refused.
- A listing that landed while the server was down is finished on the next tick.
- Buys and sells built by the site work from the user's wallet, on the curve and after graduation on PumpSwap.
- Sweeps pay the vault and buyback wallet exactly 4 to 1, before and after graduation.
- X profiles: the real name, bio and followers are saved with the account, the handle takes X's own letter case, and handles that don't exist on X are refused.
- Claims check the post comes from the right account; payouts send the whole vault and never pay twice.
- Every page loads.

## Project layout

```
src/
  server.js      entry point
  app.js         wires database, chain, API, website, scheduler
  config.js      settings
  pump.js        pump.fun calls (create, lock, verify lock, sweep, trade)
  launch.js      prepare + submit a listing, finish interrupted listings
  trade.js       buy and sell transactions for the user's wallet
  collector.js   fee sweeps, market values, chart points, 24h volume
  payout.js      pay an owner from their handle vault
  handles.js     handle checks, X profiles and pictures, plain coin names
  vanity.js      custom address endings
  api.js         HTTP API
public/          website (home, account page at /@handle, markets, claim)
sim/             local pump.fun validator, copied programs, simulator
tools/           keys, grind, launch-token, payout
test/            end-to-end tests
```
