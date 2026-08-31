/**
 * Foreign exchange market hours.
 *
 * This is the heart of what Cowrie sells. Mento's rates come from real-world FX
 * oracles, and global FX trades continuously from Sunday 21:00 UTC to Friday
 * 21:00 UTC — then shuts for the weekend. Ask Mento for a rate on a Saturday and
 * you get either "FX market is currently closed" or, worse, a bare
 * `execution reverted: no valid median`.
 *
 * An agent receiving that has no way to tell "wait until Monday" apart from
 * "this pair does not exist" or "my code is broken". So it retries forever, or
 * fails a user's payment for no reason. Knowing the clock is the difference
 * between a useless error and an actionable one.
 *
 * Hours are the standard interbank week: open Sunday 21:00 UTC (Sydney), close
 * Friday 21:00 UTC (New York close). We deliberately do NOT model banking
 * holidays — claiming precision we do not have would be worse than admitting
 * the limit, so `/status` reports this as an approximation.
 */

/** How long to tell an agent to wait when we cannot predict the resume time. */
const UNKNOWN_REOPEN_RETRY_S = 900

const OPEN_DAY = 0 // Sunday
const OPEN_HOUR = 21 // 21:00 UTC
const CLOSE_DAY = 5 // Friday
const CLOSE_HOUR = 21 // 21:00 UTC

export interface MarketState {
  open: boolean
  /**
   * Where `open` came from. "observed" means we asked Mento to price a major
   * pair and read the answer — authoritative. "schedule" means we fell back to
   * the interbank calendar, which is only an approximation.
   */
  source: 'observed' | 'schedule'
  /** Estimated ISO timestamp of the next open, when closed. */
  reopens_at?: string
  /** Estimated seconds until reopen. Approximate — see `source`. */
  retry_after?: number
  /** Estimated ISO timestamp of the next close, when open. */
  closes_at?: string
  note?: string
}

/** Is the global FX market trading at this instant? */
export function isMarketOpen(now: Date = new Date()): boolean {
  const day = now.getUTCDay()
  const hour = now.getUTCHours()

  if (day === 6) return false // Saturday: shut all day
  if (day === OPEN_DAY) return hour >= OPEN_HOUR // Sunday: opens 21:00
  if (day === CLOSE_DAY) return hour < CLOSE_HOUR // Friday: closes 21:00
  return true // Mon-Thu: continuous
}

/** The next moment the market opens. Returns `now` if already open. */
export function nextOpen(now: Date = new Date()): Date {
  if (isMarketOpen(now)) return now

  const next = new Date(now)
  next.setUTCHours(OPEN_HOUR, 0, 0, 0)

  // If it is Sunday before 21:00, the open is later today. Otherwise roll
  // forward to the coming Sunday.
  if (!(now.getUTCDay() === OPEN_DAY && now.getUTCHours() < OPEN_HOUR)) {
    const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7
    next.setUTCDate(next.getUTCDate() + daysUntilSunday)
  }
  return next
}

/** The next moment the market closes. Only meaningful while open. */
export function nextClose(now: Date = new Date()): Date {
  const next = new Date(now)
  next.setUTCHours(CLOSE_HOUR, 0, 0, 0)

  const daysUntilFriday = (CLOSE_DAY - now.getUTCDay() + 7) % 7
  if (daysUntilFriday === 0 && now.getUTCHours() >= CLOSE_HOUR) {
    next.setUTCDate(next.getUTCDate() + 7)
  } else {
    next.setUTCDate(next.getUTCDate() + daysUntilFriday)
  }
  return next
}

/**
 * Full market state, shaped for an agent to act on without further reasoning.
 *
 * Pass `observedOpen` when the caller has actually asked Mento — the calendar
 * below is only a fallback, and it has been wrong: on a Sunday evening it said
 * open while Mento still refused every FX pair. The timestamps remain
 * schedule-derived estimates either way, which is why they are labelled as
 * approximate rather than presented as facts.
 */
export function marketState(now: Date = new Date(), observedOpen?: boolean): MarketState {
  const open = observedOpen ?? isMarketOpen(now)
  const source = observedOpen === undefined ? 'schedule' : 'observed'

  if (open) {
    return { open: true, source, closes_at: nextClose(now).toISOString() }
  }

  // When the calendar says open but Mento is not pricing, we genuinely do not
  // know when feeds resume. Deriving a reopen time from the schedule here
  // yields "now", and retry_after: 0 tells an agent to busy-loop. An honest
  // "we don't know, check back in 15 minutes" is far more useful than a
  // confident wrong number.
  if (isMarketOpen(now) && source === 'observed') {
    return {
      open: false,
      source,
      retry_after: UNKNOWN_REOPEN_RETRY_S,
      note: 'The interbank calendar says markets should be trading, but Mento is not pricing FX — oracle feeds often resume later than the nominal session start. We cannot predict the exact resume time, so no reopens_at is given; poll again after retry_after.',
    }
  }

  const opens = nextOpen(now)
  return {
    open: false,
    source,
    reopens_at: opens.toISOString(),
    retry_after: Math.max(60, Math.round((opens.getTime() - now.getTime()) / 1000)),
  }
}
