/**
 * Cowrie HTTP server.
 *
 * Built on node:http with no web framework. Reviewer agents read this repo, and
 * every dependency is a thing they have to trust; four endpoints do not justify
 * one. Payment gating (x402) is layered on separately so the pricing logic stays
 * testable without a wallet.
 */
import { createServer } from 'node:http'
import { getQuote } from './fx.js'
import { loadCurrencies, listCurrencies } from './tokens.js'
import { marketState, isMarketOpen } from './market.js'
import { allCached } from './cache.js'

/**
 * Currencies that trade around the clock, because moving between them crosses
 * no exchange rate — they are all claims on the same dollar. Verified live on a
 * Sunday: USDm -> USDC priced fine while every FX pair was refused.
 *
 * Everything else needs an oracle, and oracles keep interbank hours.
 */
const ALWAYS_ON = new Set(['USD', 'USDC', 'USDT', 'axlUSDC'])

const PORT = Number(process.env.PORT ?? 8080)
const RPC_URL = process.env.CELO_RPC_URL // optional; falls back to public RPC

/** Agents parse JSON, not HTML. Everything — including errors — is JSON. */
function json(res: any, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * Self-description at the root.
 *
 * An agent that finds this service needs to learn how to use it without a human
 * reading docs, so the root returns the full endpoint list and an example.
 */
function serviceDescription() {
  return {
    name: 'Cowrie',
    description:
      'Foreign exchange rates for autonomous agents, priced on Celo via the Mento protocol.',
    version: '0.1.0',
    chain: { name: 'Celo', chain_id: 42220 },
    endpoints: {
      'GET /': 'This description.',
      'GET /currencies': 'Every supported currency with its ISO code and on-chain address.',
      'GET /pairs': 'Which pairs are quotable right now, and which are waiting on market hours.',
      'GET /status': 'FX market state and service health.',
      'GET /quote?from=USD&to=NGN&amount=100': 'Price an amount from one currency into another.',
    },
    example: '/quote?from=USD&to=NGN&amount=100',
    notes: [
      'Currencies accept ISO 4217 codes (USD, NGN) or Mento symbols (USDm, NGNm).',
      'Global FX markets close Friday 21:00 UTC and reopen Sunday 21:00 UTC. While closed, quotes return code "market_closed" with a retry_after in seconds.',
    ],
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method !== 'GET') {
    return json(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET.' } })
  }

  try {
    if (path === '/') {
      return json(res, 200, serviceDescription())
    }

    if (path === '/status') {
      const market = marketState()
      return json(res, 200, {
        ok: true,
        market,
        chain: { name: 'Celo', chain_id: 42220 },
        note: 'Market hours are the standard interbank week and do not account for banking holidays.',
      })
    }

    if (path === '/currencies') {
      const map = await loadCurrencies(RPC_URL)
      const currencies = listCurrencies(map).map((c) => ({
        iso: c.iso,
        symbol: c.symbol,
        name: c.name,
        address: c.address,
        decimals: c.decimals,
      }))
      return json(res, 200, { count: currencies.length, currencies })
    }

    if (path === '/pairs') {
      const map = await loadCurrencies(RPC_URL)
      const currencies = listCurrencies(map)
      const open = isMarketOpen()
      const market = marketState()
      const cached = new Map(allCached().map((c) => [`${c.from}/${c.to}`, c]))

      // Every ordered pair, classified by whether it can be priced right now.
      const pairs = []
      for (const a of currencies) {
        for (const b of currencies) {
          if (a.iso === b.iso) continue
          // A pair avoids the FX oracle only if BOTH sides are dollar claims.
          const alwaysOn = ALWAYS_ON.has(a.iso) && ALWAYS_ON.has(b.iso)
          const last = cached.get(`${a.iso}/${b.iso}`)
          pairs.push({
            pair: `${a.iso}/${b.iso}`,
            availability: alwaysOn ? 'always_on' : 'market_hours',
            quotable_now: alwaysOn || open,
            ...(last ? { last_known_rate: last.rate, last_seen: last.observed_at } : {}),
          })
        }
      }

      const quotable = pairs.filter((p) => p.quotable_now).length
      return json(res, 200, {
        market,
        total_pairs: pairs.length,
        quotable_now: quotable,
        waiting_on_market: pairs.length - quotable,
        note: 'Pairs between dollar-denominated tokens need no FX oracle, so they trade continuously. Every other pair follows interbank market hours.',
        pairs,
      })
    }

    if (path === '/quote') {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const amount = url.searchParams.get('amount') ?? '1'

      if (!from || !to) {
        return json(res, 400, {
          error: {
            code: 'invalid_request',
            message: 'Both "from" and "to" are required.',
            example: '/quote?from=USD&to=NGN&amount=100',
          },
        })
      }

      const result = await getQuote(from, to, amount, RPC_URL)

      if (result.ok) return json(res, 200, result.quote)

      // 503 for "come back later", 400 for "you asked wrong". The distinction
      // matters: an agent should retry the first and never retry the second.
      const retryable =
        result.error.code === 'market_closed' ||
        result.error.code === 'rate_unavailable' ||
        result.error.code === 'upstream_error'

      const headers: Record<string, string> = {}
      if (result.error.retry_after) headers['retry-after'] = String(result.error.retry_after)

      return json(res, retryable ? 503 : 400, { error: result.error }, headers)
    }

    return json(res, 404, {
      error: { code: 'not_found', message: `No endpoint at ${path}.`, see: '/' },
    })
  } catch (err) {
    return json(res, 500, {
      error: { code: 'internal_error', message: (err as Error).message },
    })
  }
})

server.listen(PORT, () => {
  console.log(`Cowrie listening on http://localhost:${PORT}`)
  const m = marketState()
  console.log(
    m.open
      ? `FX market OPEN (closes ${m.closes_at})`
      : `FX market CLOSED (reopens ${m.reopens_at}, in ${m.retry_after}s)`
  )
})
