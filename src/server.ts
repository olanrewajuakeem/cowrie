/**
 * Server entrypoint, for both local development and Vercel.
 *
 * Express exists here only to host the x402 payment middleware, which is
 * written for it. Every endpoint still runs through the framework-free
 * `handle` in handler.ts — Express just gates /swap on payment and passes
 * everything else straight through.
 */
import express from 'express'
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { handle } from './handler.js'
import { marketState } from './market.js'
import { detectMarketOpen } from './fx.js'
import { cacheBackend } from './cache.js'

// Load .env for local development. On Vercel there is no such file and the
// environment is already populated, so a missing file is expected, not an error.
try {
  process.loadEnvFile?.('.env')
} catch {
  // no .env present — rely on the ambient environment
}

const PORT = Number(process.env.PORT ?? 8080)
const X402_API_KEY = process.env.X402_API_KEY
const PAY_TO = process.env.PAY_TO ?? '0xc3A2AE793B4aCC88620E538201913A7F042edA0D'

/** $0.001 per call. Both tokens are 6-decimal, so 1000 units. */
const PRICE_UNITS = process.env.SWAP_PRICE_UNITS ?? '1000'

const USDC = '0xcEBA9300f2b948710d2653dD7B07f33A8B32118C'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'

/** CAIP-2 identifier for Celo mainnet. Typed so it satisfies x402's
 *  `${string}:${string}` network format rather than widening to string. */
const CELO_MAINNET: `${string}:${string}` = 'eip155:42220'

const app = express()

/**
 * Payment gating, applied only to /swap.
 *
 * Reads stay free on purpose. An agent — or a reviewer evaluating this service
 * — must be able to explore /, /currencies, /pairs, /status and /quote before
 * deciding whether the thing is worth paying for. Charging at the front door
 * would just make it look broken.
 *
 * Without an API key the service runs entirely free rather than failing to
 * start, so local development and anyone cloning the repo still works.
 */
if (X402_API_KEY) {
  const facilitator = new HTTPFacilitatorClient({
    url: 'https://api.x402.celo.org',
    createAuthHeaders: async () => ({
      verify: { 'X-API-Key': X402_API_KEY },
      settle: { 'X-API-Key': X402_API_KEY },
      supported: { 'X-API-Key': X402_API_KEY },
    }),
  })

  const resourceServer = new x402ResourceServer(facilitator)
  resourceServer.register('eip155:*', new ExactEvmScheme())

  // Accept either stablecoin — an agent should not have to hold a particular
  // one of two interchangeable dollars to use the service.
  const accepts = [
    {
      scheme: 'exact' as const,
      network: CELO_MAINNET,
      payTo: PAY_TO,
      price: { amount: PRICE_UNITS, asset: USDC, extra: { name: 'USDC', version: '2' } },
    },
    {
      scheme: 'exact' as const,
      network: CELO_MAINNET,
      payTo: PAY_TO,
      price: { amount: PRICE_UNITS, asset: USDT, extra: { name: 'USD₮', version: '1' } },
    },
  ]

  const routes: RoutesConfig = {
    'POST /swap': { accepts, description: 'Build unsigned swap transactions' },
    'GET /swap': { accepts, description: 'Build unsigned swap transactions' },
  }

  // Registered BEFORE the payment middleware so res.json is already wrapped by
  // the time it fires. The middleware returns 402 with an empty body —
  // everything is in the PAYMENT-REQUIRED header — and an agent that reads the
  // body first (many do) learns nothing. Fill it in with the same facts.
  app.use((_req, res, next) => {
    const original = res.json.bind(res)
    res.json = (body: unknown) => {
      if (res.statusCode === 402 && (!body || Object.keys(body as object).length === 0)) {
        return original({
          error: {
            code: 'payment_required',
            message: `This endpoint costs ${Number(PRICE_UNITS) / 1e6} USD per call, payable in USDC or USD₮ on Celo.`,
            how: 'Read the PAYMENT-REQUIRED response header (base64 JSON) for the payment options, pay one of them, then retry this request with the X-PAYMENT header. See https://x402.org',
            price_usd: Number(PRICE_UNITS) / 1e6,
            pay_to: PAY_TO,
            network: 'eip155:42220',
            accepts: [
              { asset: USDC, symbol: 'USDC' },
              { asset: USDT, symbol: 'USDT' },
            ],
            free_alternatives: {
              '/quote': 'Rates and route costs, free.',
              '/pairs': 'Which pairs are tradable right now, free.',
            },
          },
        })
      }
      return original(body)
    }
    next()
  })

  app.use(paymentMiddleware(routes, resourceServer))
  console.log(`x402 enabled — /swap costs ${Number(PRICE_UNITS) / 1e6} USD, paid to ${PAY_TO}`)
} else {
  console.log('x402 disabled (no X402_API_KEY) — every endpoint is free')
}

// Everything else, including /swap once payment has cleared.
app.use((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'internal_error', message: String(err) } }))
  })
})

app.listen(PORT, async () => {
  console.log(`Cowrie listening on http://localhost:${PORT}`)
  console.log(`cache backend: ${cacheBackend()}`)
  // Ask Mento rather than reporting the calendar — the banner used to claim
  // "FX market OPEN" while Mento was refusing every pair.
  const m = marketState(new Date(), await detectMarketOpen())
  console.log(
    m.open
      ? `FX market OPEN, observed (nominal close ${m.closes_at})`
      : `FX market CLOSED, observed (retry in ${m.retry_after}s${m.reopens_at ? `, ~${m.reopens_at}` : ', resume time unknown'})`
  )
})
