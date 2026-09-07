/**
 * Trading-limits probe.
 *
 * A reviewer noted there is "no min_trade_size or max_trade_size per currency
 * pair — an agent that needs to plan a 10k USD swap has no programmatic way to
 * check feasibility without attempting it". Mento exposes limits, but an
 * earlier guess at the signature failed with `Address "undefined" is invalid`,
 * so find out what these actually take before building on them.
 *
 * Read-only. Run: npm run probe:limits
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Mento, ChainId } = require('@mento-protocol/mento-sdk')

const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)

const mento = await Mento.create(ChainId.CELO)
console.log('connected\n')

const pools: any[] = await mento.pools.getPools()
const usdNgn = pools.find(
  (p) =>
    [p.token0, p.token1].map(String).map((s) => s.toLowerCase()).includes(
      '0xe2702bd97ee33c88c8f6f92da3b733608aa76f71'
    )
)

console.log('=== A POOL OBJECT ===')
console.log(dump(usdNgn ?? pools[0]))

const pool = usdNgn ?? pools[0]

// Four plausible shapes: the whole object, the address string, an
// {token0,token1} pair, and the exchangeId. One of them is right.
const attempts: Array<[string, unknown]> = [
  ['pool object', pool],
  ['poolAddr string', pool?.poolAddr],
  ['{token0,token1}', { token0: pool?.token0, token1: pool?.token1 }],
  ['exchangeId', pool?.exchangeId],
]

for (const [label, arg] of attempts) {
  console.log(`\n=== getPoolTradingLimits(${label}) ===`)
  try {
    console.log(dump(await mento.trading.getPoolTradingLimits(arg as any)))
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message.split('\n')[0]}`)
  }
}

console.log('\n=== getPoolTradabilityStatus(pool object) ===')
try {
  console.log(dump(await mento.trading.getPoolTradabilityStatus(pool)))
} catch (err) {
  console.log(`FAILED: ${(err as Error).message.split('\n')[0]}`)
}
