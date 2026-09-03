# Cowrie

**Foreign exchange for autonomous agents, on Celo.**

🟢 **Live:** https://cowrie-seven.vercel.app · **ERC-8004 Agent ID:** [9796](https://celoscan.io/nft/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/9796)

An agent holding stablecoins cannot open a bank account, verify an email, or click through an API signup. Every existing FX API assumes a human did that work first. Cowrie assumes nobody did — it takes payment per call over [x402](https://x402.celo.org/), from the wallet the agent already has.

Built for the Celo **Agents at Work** hackathon.

---

## The problem

Ask [Mento](https://mento.org) for a naira rate on a Saturday and you get this:

```
execution reverted: no valid median
```

An agent receiving that cannot tell whether the currency is unsupported, its arguments are malformed, the chain is broken, or it should simply wait. So it retries forever, or fails a payment for no reason.

The real answer is that **global FX markets close at 21:00 UTC on Friday and reopen at 21:00 UTC on Sunday.** Mento's rates come from real-world FX oracles, and those oracles keep bankers' hours. Nothing in the SDK or its documentation tells you this.

Cowrie answers properly:

```json
{
  "error": {
    "code": "market_closed",
    "message": "Global FX markets are closed. Rates resume when trading reopens.",
    "reopens_at": "2026-08-30T21:00:00.000Z",
    "retry_after": 39711
  }
}
```

## Not everything sleeps

Some pairs cross no exchange rate at all. `USD → USDC` is a dollar for a dollar, so it needs no oracle and trades continuously. Verified live on a Sunday, while every FX pair was refused:

```json
{
  "from": "USD", "to": "USDC",
  "amount_in": "100", "amount_out": "99.990528",
  "rate": 0.99990528, "cost_percent": 0.02
}
```

`GET /pairs` publishes the whole map — **380 ordered pairs, 12 always-on, 368 on market hours** — so an agent planning a payment at 2am knows before it commits.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Self-description, so an agent can learn the API without docs |
| `GET /currencies` | Every currency, ISO code, on-chain address, decimals |
| `GET /pairs` | Which pairs are quotable now vs waiting on market hours |
| `GET /status` | Market state and service health |
| `GET /quote` | Price an amount between two currencies |
| `POST /swap` | Unsigned transactions that execute a conversion |

**Everything is currently free.** x402 pay-per-call is the intended model for `/swap` and is not yet implemented — this table describes what the service does today, not what is planned.

### Quote

```
GET /quote?from=USD&to=NGN&amount=100
```

Currencies accept ISO 4217 codes (`USD`, `NGN`) or Mento symbols (`USDm`, `NGNm`). Tether's on-chain symbol is `USD₮` with a Unicode tugrik sign; `USDT` is aliased to it, because no agent will type that.

### Swap

```
POST /swap
{ "from": "USD", "to": "USDC", "amount": "10", "recipient": "0xYourAgentWallet" }
```

Returns unsigned transactions — an ERC-20 approval (only when the current allowance is insufficient) followed by the swap. Cowrie never takes custody of funds and never asks for a key; it assembles calldata and hands it back.

Every transaction carries the ERC-8021 attribution tag `celo_e46217d1e056` as a data suffix, and `feeCurrency` preset so gas is paid in stablecoin.

## Gas without CELO

An agent holding only stablecoins on Celo normally cannot transact — gas is payable in CELO it does not have. Celo solves this with **fee abstraction**, built into the protocol at node level, not a paymaster or relayer.

`POST /swap` returns transactions with `feeCurrency` preset to the USD₮ adapter, so the agent pays gas in the stablecoin it already holds:

| | Address |
|---|---|
| USD₮ token | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` |
| USD₮ feeCurrency adapter | `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` |

They differ because USD₮ has 6 decimals while Celo prices gas in 18, so it is allowlisted through an adapter. Passing the token address where the adapter belongs is the most common way this fails.

## Running it

```bash
npm install
npm start
```

Optional environment:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `CELO_RPC_URL` | public RPC | A dedicated RPC endpoint |
| `COWRIE_CACHE` | `.cache/rates.json` | Where last-known rates persist |

## Honest limitations

- **The rate cache only holds what Cowrie has personally observed.** It starts empty and fills while the service runs during market hours. It is not a historical price feed.
- **Market hours are the standard interbank week and ignore banking holidays.** Claiming precision we do not have would be worse than naming the limit.
- **Naira has no oracle-free price source on Celo.** Every NGN route begins with an oracle hop, so naira cannot be quoted on weekends by any means. We report this rather than paper over it.
- **Rates are indicative until executed.** A quote is not a guarantee of fill.

## How it was built

Every fact here was verified against Celo mainnet rather than taken from documentation. The probe scripts used to establish it all are kept in `src/probe*.ts` rather than deleted, because the findings are not written down anywhere else.

Three things we hit that are worth recording:

**The published Mento docs describe an API the SDK does not have.** `tokens.list()`, `routes.find()` and `pools.list()` appear in the documentation; the shipped v3.4.0 exposes `tokens.getStableTokens()`, `routes.findRoute()` and `pools.getPools()`. We read the `.d.ts` files and reflected over the objects at runtime instead.

**The SDK's ESM build is broken.** `dist/esm/index.js` imports `./core/constants/chainId` with no file extension, which Node's ESM loader rejects with `ERR_MODULE_NOT_FOUND`. It only surfaces in production, because `tsx` tolerates it locally. Cowrie loads the working CommonJS build through `createRequire` — see [src/tokens.ts](src/tokens.ts).

**`isPairTradable` disagrees with `getAmountOut`.** Mento reported `USDm/NGNm` as tradable while the quote reverted with `no valid median`. Any agent trusting that flag walks straight into a failure. Cowrie reconciles the two.

**`getCollateralAssets()` resolves empty in production but not locally.** Same SDK version, same chain, same code — on Vercel it returns `[]` rather than throwing, silently dropping USDC, USDT, axlUSDC, axlEUROC and CELO from the registry. The visible effect was that `/currencies` served 15 instead of 20, `/pairs` 210 instead of 342, and `USD → USDC` — the one pair that works while FX markets are shut — returned `400 unsupported_currency`. Nothing errored; the API just quietly knew about fewer currencies than its own documentation claimed.

An AskBots reviewer found it by comparing the homepage against the live endpoints, which is a better test than any we were running. Cowrie now falls back to a verified collateral list, reports `degraded` on [`/status`](https://cowrie-seven.vercel.app/status) when it does, and reads every count on the landing page live rather than hardcoding it — so the page and the API cannot disagree again.

**A silent empty result is worse than an exception.** All three of these SDK faults were found by observing behaviour rather than reading code, and this one only surfaced in an environment we could not reproduce locally.

## Licence

MIT
