/**
 * Request handling, shared by both runtimes.
 *
 * Vercel invokes a function with Node's own (req, res) objects, which is
 * exactly what node:http hands a server. Keeping the logic here means local
 * development and production run identical code rather than two implementations
 * that drift apart.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getQuote } from './fx.js'
import { buildSwap } from './swap.js'
import { loadCurrencies, listCurrencies } from './tokens.js'
import { marketState, isMarketOpen } from './market.js'
import { allCached, cacheBackend } from './cache.js'

const RPC_URL = process.env.CELO_RPC_URL // optional; falls back to public RPC

/**
 * Currencies that trade around the clock, because moving between them crosses
 * no exchange rate — they are all claims on the same dollar. Verified live on a
 * Sunday: USD -> USDC priced fine while every FX pair was refused.
 */
const ALWAYS_ON = new Set(['USD', 'USDC', 'USDT', 'axlUSDC'])

/** Agents parse JSON, not HTML. Everything — including errors — is JSON. */
function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Agents may run in a browser context; there is nothing private to protect.
    'access-control-allow-origin': '*',
    ...headers,
  })
  res.end(JSON.stringify(body, null, 2))
}

/**
 * Self-description at the root, so an agent that finds this service can learn
 * to use it without a human reading documentation.
 */
function serviceDescription() {
  return {
    name: 'Cowrie',
    description:
      'Foreign exchange rates for autonomous agents, priced on Celo via the Mento protocol.',
    version: '0.1.0',
    chain: { name: 'Celo', chain_id: 42220 },
    agent_id: 9796,
    agent_card: 'https://raw.githubusercontent.com/olanrewajuakeem/cowrie/main/agent-card.json',
    endpoints: {
      'GET /': 'This description.',
      'GET /currencies': 'Every supported currency with its ISO code and on-chain address.',
      'GET /pairs': 'Which pairs are quotable right now, and which are waiting on market hours.',
      'GET /status': 'FX market state and service health.',
      'GET /quote?from=USD&to=NGN&amount=100': 'Price an amount from one currency into another.',
      'POST /swap': 'Build unsigned transactions that execute a conversion. Body: {from, to, amount, recipient}. Returns approval (when needed) and swap calldata with feeCurrency preset, so an agent holding no CELO can still settle.',
    },
    example: '/quote?from=USD&to=NGN&amount=100',
    attribution_tag: 'celo_e46217d1e056',
    notes: [
      'Currencies accept ISO 4217 codes (USD, NGN) or Mento symbols (USDm, NGNm).',
      'Global FX markets close Friday 21:00 UTC and reopen Sunday 21:00 UTC. While closed, quotes return code "market_closed" with retry_after in seconds and, where known, the last observed rate.',
      'Dollar-denominated pairs (USD, USDC, USDT, axlUSDC) cross no exchange rate and are quotable at any hour.',
    ],
  }
}

/** Read and parse a JSON request body. Returns null if it is not valid JSON. */
async function readBody(req: IncomingMessage): Promise<Record<string, string> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    return json(res, 204, null, { 'access-control-allow-methods': 'GET, POST, OPTIONS' })
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET or POST.' } })
  }

  try {
    if (path === '/') return json(res, 200, serviceDescription())

    if (path === '/status') {
      return json(res, 200, {
        ok: true,
        market: marketState(),
        chain: { name: 'Celo', chain_id: 42220 },
        cache: cacheBackend(),
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
        always_on: ALWAYS_ON.has(c.iso),
      }))
      return json(res, 200, { count: currencies.length, currencies })
    }

    if (path === '/pairs') {
      const map = await loadCurrencies(RPC_URL)
      const currencies = listCurrencies(map)
      const open = isMarketOpen()
      const cached = new Map((await allCached()).map((c) => [`${c.from}/${c.to}`, c]))

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
        market: marketState(),
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

    if (path === '/swap') {
      // Accept POST with a JSON body, and GET with query params — an agent
      // exploring the API should be able to try it from a URL bar first.
      let input: Record<string, string> = Object.fromEntries(url.searchParams)
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body === null) {
          return json(res, 400, {
            error: { code: 'invalid_request', message: 'Body must be valid JSON.' },
          })
        }
        input = { ...input, ...body }
      }

      const { from, to, amount, recipient } = input
      if (!from || !to || !amount || !recipient) {
        return json(res, 400, {
          error: {
            code: 'invalid_request',
            message: '"from", "to", "amount" and "recipient" are all required.',
            example: {
              method: 'POST',
              path: '/swap',
              body: { from: 'USD', to: 'USDC', amount: '10', recipient: '0xYourAgentWallet' },
            },
          },
        })
      }

      const result = await buildSwap(from, to, amount, recipient, RPC_URL)
      if (result.ok) return json(res, 200, result.plan)

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
}
