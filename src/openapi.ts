/**
 * OpenAPI 3.1 description, served at /openapi.json.
 *
 * Written by hand rather than generated, because the value here is not the
 * endpoint list — it is documenting the behaviour that surprises people:
 * weekend blackouts, the difference between "closed" and "unhealthy", and the
 * fee-currency gas pricing that silently breaks fee abstraction.
 */
const BASE = process.env.PUBLIC_URL ?? 'https://cowrie-seven.vercel.app'

export function openapi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cowrie',
      version: '0.1.0',
      summary: 'Foreign exchange rates and swap execution for autonomous agents on Celo.',
      description: [
        'Cowrie prices currency conversions using the Mento protocol on Celo mainnet and',
        'returns unsigned transactions an agent can sign itself. It never takes custody of',
        'funds and never asks for a key.',
        '',
        'Two behaviours are worth knowing before you integrate:',
        '',
        '1. Mento\'s FX rates come from real-world foreign exchange oracles, which stop',
        '   reporting at weekends. Quotes then fail. Cowrie distinguishes "the market is',
        '   closed" from "this feed is unhealthy" and tells you when to retry. Market state',
        '   is observed by asking Mento to price a major pair, not inferred from a calendar.',
        '',
        '2. Pairs between dollar-denominated tokens (USD, USDC, USDT, axlUSDC) cross no',
        '   exchange rate, need no oracle, and are quotable at any hour.',
        '',
        'Reads are free. POST /swap costs $0.001 per call, paid over x402.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: BASE }],
    paths: {
      '/': {
        get: {
          summary: 'Service description',
          description:
            'Self-description so an agent can learn the API without documentation. Returns HTML to browsers and JSON to everything else.',
          responses: { '200': { description: 'Service metadata' } },
        },
      },
      '/openapi.json': {
        get: { summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1' } } },
      },
      '/status': {
        get: {
          summary: 'Market state and service health',
          description:
            'The `market.source` field says where the state came from: "observed" means Mento was asked to price a major pair; "schedule" means we fell back to the interbank calendar, which is only an approximation.',
          responses: { '200': { description: 'Health and market state' } },
        },
      },
      '/currencies': {
        get: {
          summary: 'Supported currencies',
          description:
            'Every currency with its ISO code, Mento symbol, on-chain address and decimals. `tradable: false` means the token exists on Celo but has no Mento pool — CELO itself is the notable case.',
          responses: { '200': { description: 'Currency list' } },
        },
      },
      '/pairs': {
        get: {
          summary: 'Pair availability',
          description:
            'Every pair with a real Mento route, labelled `always_on` (no FX oracle needed) or `market_hours`. Includes the last rate observed for each pair, where one is known.',
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
              description: 'ISO 4217 code or Mento symbol.',
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
            '200': { description: 'A quote' },
            '400': {
              description:
                'Do not retry. Unknown currency, identical currencies, or a malformed amount.',
            },
            '503': {
              description:
                'Retry later. `market_closed` (FX shut — includes `retry_after` and, where known, the last observed rate), `rate_unavailable` (oracle unhealthy), or `upstream_error`.',
            },
          },
        },
      },
      '/swap': {
        post: {
          summary: 'Build unsigned swap transactions',
          description: [
            'Returns an ERC-20 approval (only when the current allowance is insufficient)',
            'followed by the swap, both ready to sign.',
            '',
            'Each transaction includes `feeCurrency` plus `maxFeePerGas` and',
            '`maxPriorityFeePerGas` **denominated in that fee currency**. This matters: when',
            'gas is paid in an ERC-20, Celo expresses the block base fee in that token, but',
            'viem and ethers estimate against CELO and produce a cap the node rejects with',
            '"max fee per gas less than block base fee". Use the values returned here.',
            '',
            'Send the transactions in order, waiting for each to confirm.',
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
                      description: 'The address that will sign and receive.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'A swap plan with unsigned transactions' },
            '400': { description: 'Do not retry. Bad input.' },
            '402': {
              description:
                'Payment required. Read the PAYMENT-REQUIRED header (base64 JSON), pay one of the options, and retry with an X-PAYMENT header. See https://x402.org',
            },
            '503': { description: 'Retry later. Market closed or oracle unhealthy.' },
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
