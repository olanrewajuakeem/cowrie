/**
 * One version string.
 *
 * A reviewer spotted "version mismatch between GET / reporting 0.1.0 and
 * openapi.json claiming 0.2.0". Two hand-maintained copies drifted apart, which
 * is exactly the kind of small inconsistency that makes a reader distrust
 * everything else. There is now one.
 */
export const VERSION = '0.3.0'

/** Price of one POST /swap call, in USD. Disclosed everywhere, not only at 402. */
export const SWAP_PRICE_USD = Number(process.env.SWAP_PRICE_UNITS ?? '1000') / 1e6
