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

const OPEN_DAY = 0 // Sunday
const OPEN_HOUR = 21 // 21:00 UTC
const CLOSE_DAY = 5 // Friday
const CLOSE_HOUR = 21 // 21:00 UTC

export interface MarketState {
  open: boolean
  /** ISO timestamp of the next open, when closed. */
  reopens_at?: string
  /** Seconds until reopen — what an agent actually needs for its retry timer. */
  retry_after?: number
  /** ISO timestamp of the next close, when open. */
  closes_at?: string
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

/** Full market state, shaped for an agent to act on without further reasoning. */
export function marketState(now: Date = new Date()): MarketState {
  if (isMarketOpen(now)) {
    const closes = nextClose(now)
    return { open: true, closes_at: closes.toISOString() }
  }
  const opens = nextOpen(now)
  return {
    open: false,
    reopens_at: opens.toISOString(),
    retry_after: Math.max(0, Math.round((opens.getTime() - now.getTime()) / 1000)),
  }
}
