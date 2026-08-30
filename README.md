# Cowrie

**Foreign exchange for autonomous agents, on Celo.**

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

| Endpoint | Cost | Purpose |
|---|---|---|
| `GET /` | free | Self-description, so an agent can learn the API without docs |
| `GET /currencies` | free | Every currency, ISO code, on-chain address, decimals |
| `GET /pairs` | free | Which pairs are quotable now vs waiting on market hours |
| `GET /status` | free | Market state and service health |
| `GET /quote` | free | Price an amount between two currencies |
| `POST /swap` | **x402** | Unsigned transaction, gas payable in stablecoin |

Reads are free deliberately — an agent must be able to explore and evaluate the service before paying. Only execution costs money.

### Quote

```
GET /quote?from=USD&to=NGN&amount=100
```

Currencies accept ISO 4217 codes (`USD`, `NGN`) or Mento symbols (`USDm`, `NGNm`). Tether's on-chain symbol is `USD₮` with a Unicode tugrik sign; `USDT` is aliased to it, because no agent will type that.

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

Every fact here was verified against Celo mainnet rather than taken from documentation — the published Mento docs describe an API that does not match the shipped SDK, and the weekend blackout is documented nowhere. The probe scripts used to establish all of it are kept in `src/probe*.ts`.

## Licence

MIT
