/**
 * OpenAPI 3.1 description, served at /openapi.json.
 *
 * Error responses are generated from the same ERROR_CATALOGUE that the landing
 * page and GET /errors render, so the three cannot disagree. A reviewer noted
 * that documentation "relies on an external OpenAPI spec rather than rendering
 * complete information on the page itself" — the answer is not to move
 * information from one place to the other, but to have one source and three
 * views of it.
 */
import { ERROR_CATALOGUE, type ErrorDoc } from './errors.js'
import { VERSION } from './version.js'

const BASE = process.env.PUBLIC_URL ?? 'https://cowrie-seven.vercel.app'

/** Build OpenAPI responses for the given error codes, with real payloads. */
function responsesFor(codes: string[]) {
  const byStatus = new Map<number, ErrorDoc[]>()
  for (const code of codes) {
    const doc = ERROR_CATALOGUE.find((e) => e.code === code)
    if (!doc) continue
    if (!byStatus.has(doc.status)) byStatus.set(doc.status, [])
    byStatus.get(doc.status)!.push(doc)
  }

  const out: Record<string, unknown> = {}
  for (const [status, docs] of byStatus) {
    out[String(status)] = {
      description: docs
        .map((d) => `**${d.code}** — ${d.when} _Handling: ${d.handling}_`)
        .join('\n\n'),
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
          examples: Object.fromEntries(
            docs.map((d) => [d.code, { summary: d.code, value: d.example }])
          ),
        },
      },
    }
  }
  return out
}

export function openapi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cowrie',
      version: VERSION,
      summary: 'Foreign exchange rates and swap execution for autonomous agents on Celo.',
      description: [
        'Cowrie prices currency conversions using the Mento protocol on Celo mainnet and',
        'returns unsigned transactions an agent signs itself. It never takes custody of',
        'funds and never asks for a key.',
        '',
        '## Behaviour worth knowing before you integrate',
        '',
        '**FX oracles stop reporting at weekends.** Quotes for any pair that crosses an',
        'exchange rate then fail. Cowrie distinguishes "the market is closed" from "this',
        'feed is unhealthy", returns a retry window, and serves the last rate it observed.',
        'Market state is established by asking Mento to price a major pair, not inferred',
        'from a calendar. `market.source` tells you which: `observed` is authoritative,',
        '`schedule` is a fallback approximation.',
        '',
        '**Dollar-denominated pairs never sleep.** USD, USDC, USDT and axlUSDC cross no',
        'exchange rate, need no oracle, and are quotable at any hour.',
        '',
        '**Gas is paid in stablecoin.** Transactions from POST /swap carry `feeCurrency`',
        'plus `maxFeePerGas` and `maxPriorityFeePerGas` denominated in that fee currency.',
        'Use them verbatim: viem and ethers estimate against CELO and produce a cap the',
        'node rejects with "max fee per gas less than block base fee".',
        '',
        '## Cost',
        '',
        'Reads are free. POST /swap costs $0.001 per call over x402, payable in USDC or',
        'USD₮ on Celo. No account, no API key.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: BASE }],
    components: {
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', description: 'Stable machine-readable identifier.' },
                message: { type: 'string' },
                detail: { type: 'string', description: 'Underlying cause, often a revert reason.' },
                retry_after: {
                  type: 'integer',
                  description: 'Seconds to wait before retrying. Present only when waiting helps.',
                },
                reopens_at: { type: 'string', format: 'date-time' },
                supported: { type: 'array', items: { type: 'string' } },
                last_known: {
                  type: 'object',
                  description: 'The last rate observed live. Indicative only, never executable.',
                  properties: {
                    rate: { type: 'number' },
                    observed_at: { type: 'string', format: 'date-time' },
                    age_seconds: { type: 'integer' },
                    warning: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        Quote: {
          type: 'object',
          properties: {
            from: { type: 'string', examples: ['USD'] },
            to: { type: 'string', examples: ['NGN'] },
            amount_in: { type: 'string' },
            amount_out: {
              type: 'string',
              description: 'Full precision, as a string. Do not parse as a float without care.',
            },
            rate: { type: 'number', description: 'Units of `to` per one unit of `from`.' },
            inverse_rate: { type: 'number' },
            cost_percent: {
              type: ['number', 'null'],
              description: 'Total route cost. ~0.02% for AMM pools, ~1% for oracle-priced pairs.',
            },
            route: { type: 'array', items: { type: 'string' }, description: 'Ordered source to target.' },
            as_of: { type: 'string', format: 'date-time' },
            market: { $ref: '#/components/schemas/MarketState' },
          },
        },
        MarketState: {
          type: 'object',
          properties: {
            open: { type: 'boolean' },
            source: {
              type: 'string',
              enum: ['observed', 'schedule'],
              description:
                '`observed` means Mento was asked to price a major pair — authoritative. `schedule` means the interbank calendar was used, which is an approximation and has been wrong.',
            },
            reopens_at: { type: 'string', description: 'Estimate. Absent when the resume time is unknown.' },
            retry_after: { type: 'integer' },
            closes_at: { type: 'string' },
          },
        },
        UnsignedTx: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            data: { type: 'string', description: 'Calldata, with the ERC-8021 attribution suffix appended.' },
            value: { type: 'string' },
            feeCurrency: {
              type: 'string',
              description: 'Fee-currency ADAPTER address. Gas is paid in this ERC-20, not CELO.',
            },
            maxFeePerGas: {
              type: 'string',
              description:
                'Denominated in the fee currency, not CELO. Use verbatim; re-estimating produces a cap the node rejects.',
            },
            maxPriorityFeePerGas: { type: 'string' },
            description: { type: 'string', description: 'What this transaction does, in plain language.' },
          },
        },
        SwapPlan: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            amount_in: { type: 'string' },
            expected_amount_out: { type: 'string' },
            min_amount_out: { type: 'string', description: 'Slippage floor at 0.5%. The swap reverts rather than filling worse.' },
            rate: { type: 'number' },
            cost_percent: { type: ['number', 'null'] },
            route: { type: 'array', items: { type: 'string' } },
            deadline: { type: 'integer', description: 'Unix seconds. After this the swap reverts.' },
            recipient: { type: 'string' },
            transactions: {
              type: 'array',
              items: { $ref: '#/components/schemas/UnsignedTx' },
              description:
                'One or two transactions, in send order. The ERC-20 approval is included only when the current allowance is insufficient. Send in order, waiting for each to confirm.',
            },
            attribution_tag: { type: 'string' },
            next_steps: {
              type: 'object',
              description: 'How to sign and broadcast, with a worked example and a link to a reference implementation.',
              properties: {
                summary: { type: 'string' },
                steps: { type: 'array', items: { type: 'string' } },
                example: { type: 'string' },
                reference_implementation: { type: 'string' },
              },
            },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    paths: {
      '/': {
        get: {
          summary: 'Service description',
          description: 'Returns an HTML page to browsers and JSON to everything else.',
          responses: { '200': { description: 'Service metadata' } },
        },
      },
      '/openapi.json': {
        get: { summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1' } } },
      },
      '/errors': {
        get: {
          summary: 'Every error this API can return',
          description:
            'The full error catalogue with an example payload and handling guidance for each. Provided so a caller can implement failure handling without having to trigger each failure — several are only reachable at specific times, such as market_closed at weekends.',
          responses: { '200': { description: 'Error catalogue' } },
        },
      },
      '/status': {
        get: {
          summary: 'Market state and service health',
          responses: {
            '200': {
              description: 'Health and market state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      market: { $ref: '#/components/schemas/MarketState' },
                      cache: { type: 'string', enum: ['redis', 'disk'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/currencies': {
        get: {
          summary: 'Supported currencies',
          description:
            '`tradable: false` means the token exists on Celo but has no Mento pool, so it cannot be quoted or swapped. CELO itself is the notable case.',
          responses: { '200': { description: 'Currency list' } },
        },
      },
      '/pairs': {
        get: {
          summary: 'Pair availability',
          description:
            'Every pair with a real Mento route, labelled `always_on` (no FX oracle needed) or `market_hours`. Includes the last rate observed for each pair, where known. Pairs with no route are not listed at all.',
          responses: { '200': { description: 'Availability map' } },
        },
      },
      '/quote': {
        get: {
          summary: 'Price a conversion',
          parameters: [
            {
              name: 'from',
              in: 'query',
              required: true,
              schema: { type: 'string', examples: ['USD', 'NGN', 'USDm'] },
              description: 'ISO 4217 code or Mento symbol. Case-insensitive.',
            },
            {
              name: 'to',
              in: 'query',
              required: true,
              schema: { type: 'string', examples: ['NGN', 'KES'] },
            },
            {
              name: 'amount',
              in: 'query',
              required: false,
              schema: { type: 'string', default: '1' },
              description: 'Decimal amount of `from`.',
            },
          ],
          responses: {
            '200': {
              description: 'A quote',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' } } },
            },
            ...responsesFor([
              'unsupported_currency',
              'invalid_amount',
              'invalid_request',
              'market_closed',
              'rate_unavailable',
              'upstream_error',
            ]),
          },
        },
      },
      '/swap': {
        post: {
          summary: 'Build unsigned swap transactions',
          description: [
            'Returns an ERC-20 approval (only when the current allowance is insufficient)',
            'followed by the swap, both ready to sign. Cowrie holds no keys and cannot',
            'broadcast on your behalf — see `next_steps` in the response for how to submit.',
            '',
            'Costs $0.001 per call over x402.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['from', 'to', 'amount', 'recipient'],
                  properties: {
                    from: { type: 'string', examples: ['USDT'] },
                    to: { type: 'string', examples: ['NGN'] },
                    amount: { type: 'string', examples: ['100'] },
                    recipient: {
                      type: 'string',
                      pattern: '^0x[a-fA-F0-9]{40}$',
                      description:
                        'The address that will sign and receive. Must match the wallet you broadcast from.',
                    },
                  },
                },
                example: { from: 'USDT', to: 'NGN', amount: '100', recipient: '0xYourAgentWallet' },
              },
            },
          },
          responses: {
            '200': {
              description: 'A swap plan with unsigned transactions',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SwapPlan' } } },
            },
            ...responsesFor([
              'payment_required',
              'unsupported_currency',
              'invalid_amount',
              'invalid_request',
              'market_closed',
              'rate_unavailable',
              'upstream_error',
            ]),
          },
        },
      },
    },
    'x-agent': {
      erc8004AgentId: 9796,
      erc8004Registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      attributionTag: 'celo_e46217d1e056',
      chain: { name: 'Celo', chainId: 42220 },
      payment: { protocol: 'x402', priceUsd: 0.001, assets: ['USDC', 'USDT'] },
    },
  }
}
