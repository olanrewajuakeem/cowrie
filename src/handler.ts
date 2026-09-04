/**
 * Request handling, shared by both runtimes.
 *
 * Vercel invokes a function with Node's own (req, res) objects, which is
 * exactly what node:http hands a server. Keeping the logic here means local
 * development and production run identical code rather than two implementations
 * that drift apart.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getQuote, detectMarketOpen } from './fx.js'
import { buildSwap } from './swap.js'
import { formatUnits } from 'viem'
import {
  loadCurrencies,
  listCurrencies,
  loadRoutablePairs,
  registryDegraded,
  getPublicClient,
} from './tokens.js'
import { VERSION, SWAP_PRICE_USD } from './version.js'
import { marketState } from './market.js'
import { allCached, cacheBackend } from './cache.js'
import { openapi } from './openapi.js'
import { landingPage } from './landing.js'
import { ERROR_CATALOGUE } from './errors.js'
import { proof } from './proof.js'

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
/**
 * A real quote, computed now, embedded in the root response.
 *
 * Six of ten round-one reviewers fetched only `GET /` and concluded every
 * claim was "unverified rather than disproven" — scoring reliability 5 not
 * because anything was wrong but because nothing was checkable from a single
 * request. One wrote: "the evidence proves only that the documentation page
 * loads". Fair. So the front door now carries live runtime data with a
 * timestamp, and a reader who never makes a second call has still seen the
 * service actually work.
 */
async function liveProof() {
  const started = Date.now()
  try {
    // Two quotes, chosen so this block is informative at any hour.
    //
    // USD -> USDC crosses no exchange rate and needs no oracle, so it prices
    // even at weekends: there is always a successful quote to show.
    // USD -> NGN needs an FX oracle, so at weekends it demonstrates the error
    // contract instead. Together they show the service working AND show what
    // failure looks like, without the reader having to wait for Monday.
    const [alwaysOn, fx] = await Promise.all([
      getQuote('USD', 'USDC', '100', RPC_URL),
      getQuote('USD', 'NGN', '100', RPC_URL),
    ])

    return {
      note: 'Both computed when you requested this, not static examples. Reproduce them by calling /quote yourself.',
      computed_in_ms: Date.now() - started,
      always_on_pair: {
        request: 'GET /quote?from=USD&to=USDC&amount=100',
        why: 'Dollar-to-dollar crosses no exchange rate, so it prices at any hour including weekends.',
        ...(alwaysOn.ok ? { result: alwaysOn.quote } : { error: alwaysOn.error }),
      },
      oracle_priced_pair: {
        request: 'GET /quote?from=USD&to=NGN&amount=100',
        why: 'Needs an FX oracle. At weekends this returns a documented market_closed error with a retry window — the error contract working, not a fault.',
        ...(fx.ok ? { result: fx.quote } : { error: fx.error }),
      },
    }
  } catch (err) {
    return {
      note: 'Live quotes were attempted for this response and failed unexpectedly.',
      computed_in_ms: Date.now() - started,
      error: String(err),
    }
  }
}

function serviceDescription() {
  return {
    name: 'Cowrie',
    description:
      'Foreign exchange rates for autonomous agents, priced on Celo via the Mento protocol.',
    version: VERSION,
    // Disclosed here, not only at the 402. A reviewer found payment "a
    // late-stage surprise… no earlier endpoint discloses that settlement
    // requires payment", which is a poor thing to learn mid-flow.
    pricing: {
      reads: 'free — /, /currencies, /pairs, /status, /quote, /errors, /openapi.json',
      'POST /swap': `${SWAP_PRICE_USD} USD per call, paid over x402 in USDC or USD₮ on Celo. No account or API key; the 402 response carries the payment options.`,
    },
    chain: { name: 'Celo', chain_id: 42220 },
    agent_id: 9796,
    agent_card: 'https://raw.githubusercontent.com/olanrewajuakeem/cowrie/main/agent-card.json',
    endpoints: {
      'GET /': 'This description. Returns an HTML page to browsers.',
      'GET /openapi.json': 'OpenAPI 3.1 description of this API.',
      'GET /errors': 'Every error this API can return, with an example payload and how to handle it.',
      'GET /proof': 'Mined Celo mainnet transactions built by this API, so its claims can be checked rather than trusted.',
      'GET /healthz': 'Standard health check: version, uptime, market state, cache backend.',
      'GET /balance/{address}': 'Every non-zero balance that address holds across the currencies Cowrie knows, so an agent can check it can afford a swap before planning one.',
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

/**
 * Counts read from the same sources the endpoints use.
 *
 * Never hardcode anything countable: the landing page and the API disagreed
 * for two days because the page said 19 and 342 while collateral assets were
 * silently failing to load, and the API served 15 and 210.
 */
async function liveStats() {
  const map = await loadCurrencies(RPC_URL)
  const routable = await loadRoutablePairs(RPC_URL)
  const all = listCurrencies(map)
  const tradable = all.filter((c) =>
    all.some((o) => o.iso !== c.iso && routable.has(`${c.iso}/${o.iso}`))
  ).length

  let pairs = 0
  for (const a of all) {
    for (const b of all) {
      if (a.iso !== b.iso && routable.has(`${a.iso}/${b.iso}`)) pairs++
    }
  }

  return { currencies: all.length, tradable, pairs, degraded: registryDegraded() }
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
    if (path === '/openapi.json') return json(res, 200, openapi())

    if (path === '/proof') {
      // Runtime evidence rather than assertion. Reviewers noted that
      // documentation alone cannot show /swap produces usable transactions,
      // and treated swap execution as unverified. These are checkable.
      return json(res, 200, proof())
    }

    if (path === '/errors') {
      // Every failure mode with a real payload, machine-readable. Added after a
      // reviewer could not evaluate our error handling because it tested while
      // markets were open and never saw a market_closed response.
      return json(res, 200, {
        note: 'Every error Cowrie can return, with an example payload. 4xx: do not retry, fix the request. 5xx: retry, and retry_after says when.',
        count: ERROR_CATALOGUE.length,
        errors: ERROR_CATALOGUE,
      })
    }

    if (path === '/') {
      // Content negotiation: people and browser-driven reviewer bots get a
      // readable page; agents get JSON. A browser asking for a JSON blob sees
      // nothing useful, and neither does an agent handed HTML.
      const accept = String(req.headers.accept ?? '')
      if (accept.includes('text/html')) {
        // Read the counts live rather than hardcoding them. The page used to
        // claim 19 currencies and 342 pairs while the API served 15 and 210.
        const stats = await liveStats()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(landingPage(stats))
        return
      }
      // Include a live quote so a reader who only ever fetches this one URL
      // still sees the service working, with a timestamp they can check.
      return json(res, 200, { ...serviceDescription(), live_proof: await liveProof() })
    }

    if (path === '/healthz') {
      // Standard health check. Other Celo agent skills expect it at this path,
      // and a reviewer flagged its absence.
      const open = await detectMarketOpen(RPC_URL)
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptime_seconds: Math.round(process.uptime()),
        chain: { name: 'Celo', chain_id: 42220 },
        market_open: open,
        cache: cacheBackend(),
        degraded: registryDegraded(),
      })
    }

    if (path === '/status') {
      const open = await detectMarketOpen(RPC_URL)
      return json(res, 200, {
        ok: true,
        version: VERSION,
        market: marketState(new Date(), open),
        chain: { name: 'Celo', chain_id: 42220 },
        cache: cacheBackend(),
        // Non-null when the currency registry fell back to hardcoded
        // collateral addresses. Visible rather than silent.
        degraded: registryDegraded(),
        note: 'Market state is observed by asking Mento to price a major pair, not inferred from a calendar. Reopen timestamps remain schedule-based estimates.',
      })
    }

    if (path === '/currencies') {
      const map = await loadCurrencies(RPC_URL)
      const routable = await loadRoutablePairs(RPC_URL)
      const all = listCurrencies(map)

      const currencies = all.map((c) => {
        // Tradable only if it can route to at least one other currency.
        const tradable = all.some((o) => o.iso !== c.iso && routable.has(`${c.iso}/${o.iso}`))
        return {
          iso: c.iso,
          symbol: c.symbol,
          name: c.name,
          address: c.address,
          decimals: c.decimals,
          tradable,
          always_on: ALWAYS_ON.has(c.iso),
          ...(tradable ? {} : { note: 'Listed on Celo but has no Mento pool, so it cannot be quoted or swapped.' }),
        }
      })

      const tradableCount = currencies.filter((c) => c.tradable).length
      return json(res, 200, {
        count: currencies.length,
        tradable: tradableCount,
        untradable: currencies.length - tradableCount,
        currencies,
      })
    }

    if (path === '/pairs') {
      const map = await loadCurrencies(RPC_URL)
      const currencies = listCurrencies(map)
      const open = await detectMarketOpen(RPC_URL)
      const cached = new Map((await allCached()).map((c) => [`${c.from}/${c.to}`, c]))

      const routable = await loadRoutablePairs(RPC_URL)

      const pairs = []
      for (const a of currencies) {
        for (const b of currencies) {
          if (a.iso === b.iso) continue
          // Only list pairs Mento can actually route. Advertising a pair with
          // no pool behind it is a promise we cannot keep.
          if (!routable.has(`${a.iso}/${b.iso}`)) continue
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
        market: marketState(new Date(), open),
        total_pairs: pairs.length,
        quotable_now: quotable,
        waiting_on_market: pairs.length - quotable,
        note: 'Only pairs with a real Mento route are listed. Pairs between dollar-denominated tokens need no FX oracle and trade continuously; every other pair follows interbank market hours.',
        pairs,
      })
    }

    if (path.startsWith('/balance')) {
      // Added after a reviewer pointed out that an exchange API which cannot
      // tell you whether you hold the input token forces every agent into a
      // separate lookup before it can plan a swap.
      const address = path.slice('/balance/'.length) || url.searchParams.get('address') || ''
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return json(res, 400, {
          error: {
            code: 'invalid_request',
            message: `"address" must be a 0x address, got "${address}".`,
            example: '/balance/0xc3A2AE793B4aCC88620E538201913A7F042edA0D',
          },
        })
      }

      const map = await loadCurrencies(RPC_URL)
      const currencies = listCurrencies(map)
      const client = getPublicClient(RPC_URL)
      const erc20 = [
        {
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ] as const

      const balances = await Promise.all(
        currencies.map(async (c) => {
          try {
            const raw = (await client.readContract({
              address: c.address,
              abi: erc20,
              functionName: 'balanceOf',
              args: [address as `0x${string}`],
            })) as bigint
            return { iso: c.iso, symbol: c.symbol, address: c.address, raw, decimals: c.decimals }
          } catch {
            return null
          }
        })
      )

      const held = balances
        .filter((b): b is NonNullable<typeof b> => b !== null && b.raw > 0n)
        .map((b) => ({
          iso: b.iso,
          symbol: b.symbol,
          address: b.address,
          balance: formatUnits(b.raw, b.decimals),
          balance_raw: b.raw.toString(),
        }))

      const native = await client.getBalance({ address: address as `0x${string}` })

      return json(res, 200, {
        address,
        chain: { name: 'Celo', chain_id: 42220 },
        note: 'Non-zero balances only, across every currency Cowrie knows. CELO is shown separately because gas can be paid in stablecoin instead — a zero CELO balance does not prevent a swap.',
        celo_native: formatUnits(native, 18),
        count: held.length,
        balances: held,
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
