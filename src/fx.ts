/**
 * Quote engine.
 *
 * Wraps Mento's on-chain pricing in an answer an agent can act on. The valuable
 * part is not `getAmountOut` — anyone can call that. It is the error handling:
 * turning `execution reverted: no valid median` into "the market is shut until
 * Sunday 21:00 UTC, retry in 108000 seconds".
 */
import { parseUnits, formatUnits } from 'viem'
import { getMento, loadCurrencies, resolve, type Currency } from './tokens.js'
import { isMarketOpen, marketState, nextOpen, type MarketState } from './market.js'
import { remember, recall, type StaleRate } from './cache.js'

export interface Quote {
  from: string
  to: string
  amount_in: string
  amount_out: string
  /** Units of `to` per single unit of `from`. */
  rate: number
  inverse_rate: number
  /** Total cost of the swap as a percentage, from Mento's route data. */
  cost_percent: number | null
  route: string[]
  as_of: string
  /**
   * How long this quote should be treated as usable, in seconds.
   *
   * Requested by reviewers who wanted a mechanical staleness check rather than
   * having to reason about `as_of` themselves. Oracle-priced pairs move with
   * the feed; dollar-denominated pairs are far more stable. This is guidance,
   * not a guarantee — a quote is indicative until executed.
   */
  max_age_seconds: number
  /**
   * ISO timestamp when this quote should be considered stale.
   *
   * `as_of + max_age_seconds`, computed here so an agent does not have to do
   * date arithmetic to answer "is this still good?" — a reviewer noted having
   * to derive it themselves.
   */
  expires_at: string
  market: MarketState
}

export type ErrorCode =
  | 'market_closed'
  | 'rate_unavailable'
  | 'unsupported_currency'
  | 'invalid_amount'
  | 'invalid_request'
  | 'upstream_error'

export interface FxError {
  code: ErrorCode
  message: string
  detail?: string
  /** Seconds to wait before retrying. Present when waiting will actually help. */
  retry_after?: number
  reopens_at?: string
  supported?: string[]
  /**
   * The last rate we observed live, when the market is shut. Explicitly stale —
   * an agent can use it to estimate, but must not treat it as executable.
   */
  last_known?: StaleRate & { warning: string }
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; error: FxError }

/**
 * Classify a raw Mento failure.
 *
 * Mento reports a closed market two different ways: an explicit English message
 * for the majors (EUR, GBP, CHF, JPY), and a bare `no valid median` for
 * everything else — because those oracles simply stop reporting at the weekend.
 *
 * `no valid median` is ambiguous on its own: it means "closed" on a Saturday and
 * "this feed is genuinely unhealthy" on a Tuesday. We use the clock to tell
 * those apart, which is the only way to give an agent a retry time it can trust.
 */
export async function classifyError(
  err: unknown,
  now: Date,
  from?: string,
  to?: string
): Promise<FxError> {
  const raw = err instanceof Error ? err.message : String(err)
  // viem puts "...reverted with the following reason:" on line one and the
  // actual reason on line two, so line one alone tells an agent nothing.
  const first = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')

  /**
   * Ask whether FX is actually trading rather than consulting the calendar.
   *
   * Different oracle feeds stop and resume at different times: at 23:15 UTC on
   * a Friday, EUR was still pricing while NGN had already gone quiet. Calling
   * that "global FX markets are closed" is wrong, and it produced a response
   * asserting markets were open beside one saying they were shut.
   *
   * If a major pair still prices, the market is open and this feed
   * specifically is unavailable — a materially different instruction for the
   * caller: minutes, not until Sunday.
   */
  const closedByClock = !(await detectMarketOpen())

  if (/FX market is currently closed/i.test(raw) || (/no valid median/i.test(raw) && closedByClock)) {
    const opens = nextOpen(now)
    const stale = from && to ? await recall(from, to) : null
    return {
      code: 'market_closed',
      message: 'Global FX markets are closed. Rates resume when trading reopens.',
      detail: first,
      reopens_at: opens.toISOString(),
      retry_after: Math.max(0, Math.round((opens.getTime() - now.getTime()) / 1000)),
      ...(stale
        ? {
            last_known: {
              ...stale,
              warning: 'Stale. Indicative only — not executable until the market reopens.',
            },
          }
        : {}),
    }
  }

  if (/no valid median/i.test(raw)) {
    // Other pairs are pricing, so this is feed-specific rather than a closed
    // market. Emerging-market feeds often go quiet before and resume after the
    // majors, so this can also mean "closed for this pair, but not for EUR".
    const stale = from && to ? await recall(from, to) : null
    return {
      code: 'rate_unavailable',
      message: `No oracle price is currently available for ${from ?? 'this pair'}/${to ?? ''}. Other pairs are pricing, so this is specific to this feed rather than a market-wide closure.`,
      detail: first,
      retry_after: 60,
      ...(stale
        ? {
            last_known: {
              ...stale,
              warning: 'Stale. Indicative only — not executable.',
            },
          }
        : {}),
    }
  }

  return { code: 'upstream_error', message: 'Mento could not price this pair.', detail: first }
}

/** Dollar-denominated tokens cross no exchange rate, so their quotes age slowly. */
const ALWAYS_ON = new Set(['USD', 'USDC', 'USDT', 'axlUSDC'])

let marketProbe: { at: number; open: boolean } | null = null
const MARKET_PROBE_TTL_MS = 60_000

/**
 * Ask Mento whether FX is actually trading, rather than trusting a calendar.
 *
 * We originally derived market state from the standard interbank week
 * (Sunday 21:00 to Friday 21:00 UTC) and it was wrong: on a Sunday evening our
 * clock said open while Mento still answered "FX market is currently closed"
 * for every pair. Publishing that meant telling agents 342 pairs were quotable
 * when none were.
 *
 * Mento is the authority on what Mento will price, so we quote a single major
 * pair and read the answer. Cached for a minute — this runs on the /status and
 * /pairs paths and does not need to be exact to the second.
 */
export async function detectMarketOpen(rpcUrl?: string): Promise<boolean> {
  if (marketProbe && Date.now() - marketProbe.at < MARKET_PROBE_TTL_MS) {
    return marketProbe.open
  }

  let open = false
  try {
    const currencies = await loadCurrencies(rpcUrl)
    const usd = resolve(currencies, 'USD')
    const eur = resolve(currencies, 'EUR')
    if (!usd || !eur) return isMarketOpen() // fall back to the calendar

    const mento = await getMento(rpcUrl)
    await mento.quotes.getAmountOut(usd.address, eur.address, parseUnits('1', 18))
    open = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Either message means the oracles are not pricing FX right now.
    const closed = /FX market is currently closed/i.test(msg) || /no valid median/i.test(msg)
    open = !closed
  }

  marketProbe = { at: Date.now(), open }
  return open
}

/** Price `amount` of `from` into `to`. Never throws — failures come back typed. */
export async function getQuote(
  fromInput: string,
  toInput: string,
  amount: string,
  rpcUrl?: string
): Promise<QuoteResult> {
  const now = new Date()
  const currencies = await loadCurrencies(rpcUrl)

  const from = resolve(currencies, fromInput)
  const to = resolve(currencies, toInput)

  const supported = [...new Set(currencies.values())].map((c) => c.iso).sort()

  if (!from || !to) {
    const bad = !from ? fromInput : toInput
    return {
      ok: false,
      error: {
        code: 'unsupported_currency',
        message: `Unknown currency "${bad}".`,
        supported,
      },
    }
  }

  if (from.address === to.address) {
    return {
      ok: false,
      error: { code: 'invalid_amount', message: 'Source and target currency are the same.' },
    }
  }

  const numeric = Number(amount)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return {
      ok: false,
      error: { code: 'invalid_amount', message: `Amount must be a positive number, got "${amount}".` },
    }
  }

  let amountIn: bigint
  try {
    amountIn = parseUnits(amount, from.decimals)
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_amount', message: `Amount "${amount}" is not a valid decimal.` },
    }
  }

  const mento = await getMento(rpcUrl)

  try {
    const raw = await mento.quotes.getAmountOut(from.address, to.address, amountIn)
    const out = typeof raw === 'bigint' ? raw : BigInt((raw as any)?.amountOut ?? (raw as any)?.amount)

    const amountOut = formatUnits(out, to.decimals)
    const rate = Number(amountOut) / numeric
    const bothAlwaysOn = ALWAYS_ON.has(from.iso) && ALWAYS_ON.has(to.iso)
    const maxAge = bothAlwaysOn ? 300 : 30

    /**
     * A successful quote proves FX is trading ONLY if the pair needed an
     * oracle. USD -> USDC prices at any hour, so its success says nothing
     * about market state — and reporting `open: true` from it produced a
     * response that contradicted itself, claiming markets were open beside a
     * market_closed error for naira in the same payload.
     */
    const marketOpen = bothAlwaysOn ? await detectMarketOpen(rpcUrl) : true

    // Bank every live rate we see. This is what we serve back during the
    // weekend blackout, so the cache is only ever as good as our uptime.
    if (Number.isFinite(rate) && rate > 0) await remember(from.iso, to.iso, rate)

    // Route data is a nice-to-have; never fail a good quote because it errored.
    let route: string[] = [from.iso, to.iso]
    let costPercent: number | null = null
    try {
      const r: any = await mento.routes.findRoute(from.address, to.address)
      if (r?.tokens?.length) {
        const labels = r.tokens.map((t: any) => currencyLabel(currencies, t.symbol))
        // Mento normalises route ids alphabetically, so the reported order does
        // not follow the direction of the trade. Correct it.
        route = labels[0] === from.iso ? labels : [...labels].reverse()
      }
      if (typeof r?.costData?.totalCostPercent === 'number') {
        costPercent = r.costData.totalCostPercent
      }
    } catch {
      // ignore — the quote itself is what matters
    }

    return {
      ok: true,
      quote: {
        from: from.iso,
        to: to.iso,
        amount_in: amount,
        amount_out: amountOut,
        rate,
        inverse_rate: rate === 0 ? 0 : 1 / rate,
        cost_percent: costPercent,
        route,
        as_of: now.toISOString(),
        // Dollar-to-dollar pairs cross no exchange rate and barely move;
        // anything touching an FX oracle can shift with each reporting round.
        max_age_seconds: maxAge,
        expires_at: new Date(now.getTime() + maxAge * 1000).toISOString(),
        market: marketState(now, marketOpen),
      },
    }
  } catch (err) {
    return { ok: false, error: await classifyError(err, now, from.iso, to.iso) }
  }
}

function currencyLabel(map: Map<string, Currency>, symbol: string): string {
  return resolve(map, symbol)?.iso ?? symbol
}
