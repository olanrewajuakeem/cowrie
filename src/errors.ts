/**
 * The error catalogue — one source of truth.
 *
 * An AskBots reviewer could not evaluate our error handling because it tested
 * while FX markets were open and therefore never saw a `market_closed`
 * response. It said, fairly: "the evaluator did not receive the actual status
 * code, JSON error structure, or message text". Another said there is
 * "no error handling documentation … this creates risk when paying per call,
 * as agents cannot programmatically handle failures."
 *
 * Both are right, and both have the same root cause: the failure modes were
 * only observable by triggering them. So every error Cowrie can return is
 * catalogued here with a real payload, and the landing page, the OpenAPI spec
 * and GET /errors all render from this array. Documentation cannot drift from
 * behaviour if there is only one copy of it.
 */
export interface ErrorDoc {
  code: string
  status: number
  /** Should a caller retry, and does waiting help? */
  retry: 'never' | 'after_retry_after' | 'short'
  when: string
  handling: string
  example: unknown
}

export const ERROR_CATALOGUE: ErrorDoc[] = [
  {
    code: 'market_closed',
    status: 503,
    retry: 'after_retry_after',
    when: 'The pair needs an FX oracle and global FX markets are not trading. Weekends, and the gap between the nominal session open and oracles resuming.',
    handling:
      'Wait retry_after seconds, then retry. Use last_known.rate for an estimate but never as an executable price. Pairs between dollar-denominated tokens (USD, USDC, USDT, axlUSDC) are never affected.',
    example: {
      error: {
        code: 'market_closed',
        message: 'Global FX markets are closed. Rates resume when trading reopens.',
        detail:
          'The contract function "getAmountsOut" reverted with the following reason: no valid median',
        reopens_at: '2026-09-06T21:00:00.000Z',
        retry_after: 39711,
        last_known: {
          from: 'USD',
          to: 'NGN',
          rate: 1315.177681833278,
          observed_at: '2026-09-03T07:36:12.309Z',
          age_seconds: 264000,
          warning: 'Stale. Indicative only — not executable until the market reopens.',
        },
      },
    },
  },
  {
    code: 'rate_unavailable',
    status: 503,
    retry: 'short',
    when: 'Markets are trading but this specific oracle feed has no agreed price. Usually transient.',
    handling: 'Retry after retry_after (60s). If it persists across several minutes, treat the pair as unavailable rather than looping.',
    example: {
      error: {
        code: 'rate_unavailable',
        message: 'No oracle price is currently available for this pair.',
        detail:
          'The contract function "getAmountsOut" reverted with the following reason: no valid median',
        retry_after: 60,
      },
    },
  },
  {
    code: 'unsupported_currency',
    status: 400,
    retry: 'never',
    when: 'The currency is not recognised, or exists on Celo but has no Mento pool. CELO itself is the notable case.',
    handling:
      'Do not retry. The supported array lists every valid code. GET /currencies shows which are tradable.',
    example: {
      error: {
        code: 'unsupported_currency',
        message: 'Unknown currency "XYZ".',
        supported: ['AUD', 'BRL', 'CAD', 'CHF', 'COP', 'EUR', 'GBP', 'GHS', 'JPY', 'KES', 'NGN', 'PHP', 'USD', 'USDC', 'USDT', 'XOF', 'ZAR'],
      },
    },
  },
  {
    code: 'invalid_amount',
    status: 400,
    retry: 'never',
    when: 'The amount is zero, negative, not a number, or has more decimal places than the token supports. Also returned when from and to are the same currency.',
    handling: 'Do not retry. Correct the amount.',
    example: {
      error: {
        code: 'invalid_amount',
        message: 'Amount must be a positive number, got "-5".',
      },
    },
  },
  {
    code: 'invalid_request',
    status: 400,
    retry: 'never',
    when: 'A required parameter is missing or malformed. On /swap this includes a recipient that is not a 0x address.',
    handling: 'Do not retry. The example field shows a well-formed request.',
    example: {
      error: {
        code: 'invalid_request',
        message: '"recipient" must be a 0x address, got "not-an-address".',
      },
    },
  },
  {
    code: 'payment_required',
    status: 402,
    retry: 'never',
    when: 'POST /swap was called without payment. Reads are free; execution is not.',
    handling:
      'Read the PAYMENT-REQUIRED response header (base64 JSON), pay one of the options, and retry with an X-PAYMENT header. See https://x402.org',
    example: {
      error: {
        code: 'payment_required',
        message: 'This endpoint costs 0.001 USD per call, payable in USDC or USD₮ on Celo.',
        price_usd: 0.001,
        pay_to: '0xc3A2AE793B4aCC88620E538201913A7F042edA0D',
        network: 'eip155:42220',
      },
    },
  },
  {
    code: 'upstream_error',
    status: 503,
    retry: 'short',
    when: 'Mento could not price the pair for a reason we do not recognise. The detail field carries the raw revert reason.',
    handling:
      'Retry once. If detail says "No route found", the pair has no tradable path and retrying will not help — treat it as unsupported.',
    example: {
      error: {
        code: 'upstream_error',
        message: 'Mento could not price this pair.',
        detail:
          'No route found for tokens 0x471EcE3750Da237f93B8E339c536989b8978a438 and 0x765DE816845861e75A25fCA122bb6898B8B1282a. They may not have a tradable path.',
      },
    },
  },
  {
    code: 'facilitator_timeout',
    status: 502,
    retry: 'short',
    when: 'The x402 payment middleware could not reach Celo\'s facilitator at api.x402.celo.org within 30 seconds. Raised by the payment layer before Cowrie\'s own code runs, so the shape differs from the errors above.',
    handling:
      'Safe to retry — no payment was signed or settled, and nothing was charged. Wait a few seconds. If it persists, the facilitator is degraded; /quote and every other read endpoint are unaffected and remain free.',
    example: {
      error: 'Facilitator supported request timed out after 30000ms',
    },
  },
  {
    code: 'not_found',
    status: 404,
    retry: 'never',
    when: 'No endpoint at that path.',
    handling: 'Do not retry. GET / lists every endpoint.',
    example: {
      error: { code: 'not_found', message: 'No endpoint at /rates.', see: '/' },
    },
  },
]

/** Quick lookup for the docs pages. */
export const RETRY_LABEL: Record<ErrorDoc['retry'], string> = {
  never: 'Never — fix the request',
  after_retry_after: 'Yes, after retry_after seconds',
  short: 'Yes, after a short pause',
}
