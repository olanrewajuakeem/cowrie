/**
 * Pool discovery probe — the question that decides whether Cowrie can be 24/7.
 *
 * Mento runs two kinds of pool:
 *   - "Virtual" (BiPoolManager): priced by an oracle. Dies when FX markets close.
 *   - Fixed-product AMM: priced from its own reserves. Never closes.
 *
 * Every USDm pair we tried used a Virtual pool, which is why the whole sweep
 * went dark on a Saturday. If ANY constant-product pool exists — especially on
 * a naira pair — that is our 24/7 price source and the product thesis holds.
 *
 * Free reads only. Run: npm run probe:pools
 */
import { Mento, ChainId } from '@mento-protocol/mento-sdk'

const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)

const mento = await Mento.create(ChainId.CELO)
console.log('connected to Celo mainnet\n')

const pools: any[] = await mento.pools.getPools()
console.log(`=== ${pools.length} POOLS TOTAL ===\n`)

// Group by pool type. This single tally answers the whole question.
const byType = new Map<string, any[]>()
for (const p of pools) {
  const type = String(p?.poolType ?? 'unknown')
  if (!byType.has(type)) byType.set(type, [])
  byType.get(type)!.push(p)
}

console.log('=== POOL TYPES ===')
for (const [type, list] of byType) {
  console.log(`  ${type}: ${list.length}`)
}

// Any pool that is not oracle-priced is a candidate 24/7 source.
const nonVirtual = pools.filter((p) => String(p?.poolType ?? '') !== 'Virtual')
console.log(`\n=== NON-VIRTUAL (potential 24/7) : ${nonVirtual.length} ===`)
if (nonVirtual.length) {
  console.log(dump(nonVirtual.slice(0, 10)))
} else {
  console.log('none — every pool is oracle-priced, so Mento alone cannot be 24/7')
}

// What does a single pool actually expose? Reserves would let us price directly
// from liquidity, bypassing the oracle entirely.
console.log('\n=== SAMPLE POOL SHAPE ===')
console.log(dump(pools[0]))

console.log('\n=== POOL DETAILS (first pool) ===')
try {
  console.log(dump(await mento.pools.getPoolDetails(pools[0])))
} catch (err) {
  console.log(`FAILED: ${(err as Error).message.split('\n')[0]}`)
}

// Naira specifically — the corridor we are leading with.
const NGN = '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71'.toLowerCase()
const ngnPools = pools.filter((p) =>
  [p?.token0, p?.token1, p?.asset0, p?.asset1]
    .filter(Boolean)
    .some((a: string) => String(a).toLowerCase() === NGN)
)
console.log(`\n=== NGN POOLS: ${ngnPools.length} ===`)
console.log(dump(ngnPools))
