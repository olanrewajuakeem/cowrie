/**
 * The decisive experiment.
 *
 * FPMM pools price from their own reserves and need no oracle, yet USDm->EURm
 * still failed with "FX market is currently closed" during the weekend sweep.
 * Two possible explanations, with very different consequences:
 *
 *   A) The router picked the Virtual (oracle) pool and never tried the FPMM one.
 *      -> We can force the FPMM route and quote 24/7. Thesis holds.
 *   B) Mento halts ALL trading while FX is shut, FPMM included.
 *      -> No 24/7 quoting through the router. We would have to read reserves
 *         ourselves and do the constant-product maths.
 *
 * Either way we also want to know whether pool reserves are readable, because
 * that is the fallback that does not depend on Mento's permission.
 *
 * Free reads. Run: npm run probe:fpmm
 */
import { Mento, ChainId } from '@mento-protocol/mento-sdk'
import { parseUnits, formatUnits } from 'viem'

const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)

const USDm = '0x765DE816845861e75A25fCA122bb6898B8B1282a'
const EURm = '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73'
const NGNm = '0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71'
const FPMM_USDm_EURm = '0x1aD2EA06502919F935D9c09028dF73a462979e29'

const mento = await Mento.create(ChainId.CELO)
console.log('connected\n')

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n=== ${title} ===`)
  try {
    await fn()
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message.split('\n').slice(0, 3).join(' | ')}`)
  }
}

// 1. Can we read reserves? If yes, we can always compute a price ourselves,
//    regardless of what the router allows.
await section('POOL DETAILS by address (reserves?)', async () => {
  console.log(dump(await mento.pools.getPoolDetails(FPMM_USDm_EURm as any)))
})

// 2. How many routes exist for a pair that has BOTH pool types? If the SDK
//    returns two, we can choose the FPMM one deliberately.
// getRoutes() takes no pair arguments — it returns every route on the protocol,
// so we filter by id ourselves.
await section('ALL ROUTES: USDm -> EURm', async () => {
  const all = await mento.routes.getRoutes()
  const routes = all.filter((r: any) => /USDm/.test(r.id) && /EURm/.test(r.id))
  console.log(`${routes.length} route(s) of ${all.length} total`)
  console.log(dump(routes))
})

// 3. The same for naira — expected to be oracle-only, but confirm it.
await section('ALL ROUTES: USDm -> NGNm', async () => {
  const all = await mento.routes.getRoutes()
  const routes = all.filter((r: any) => /NGNm/.test(r.id))
  console.log(`${routes.length} NGN route(s) of ${all.length} total`)
  console.log(
    dump(routes.map((r: any) => ({ id: r.id, types: r.path?.map((p: any) => p.poolType) })))
  )
})

// 4. Is the halt at the router level or the pool level? A direct quote on a
//    pair whose only liquidity is FPMM answers it: USDm/USDC is stablecoin
//    liquidity with no FX component at all.
await section('QUOTE 100 USDm -> USDC (FPMM, no FX oracle involved)', async () => {
  const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'
  const out = await mento.quotes.getAmountOut(USDm as any, USDC as any, parseUnits('100', 18))
  const raw = typeof out === 'bigint' ? out : BigInt((out as any)?.amountOut ?? (out as any)?.amount)
  console.log(`100 USDm => ${formatUnits(raw, 6)} USDC  <-- if this works, FPMM trades while FX is shut`)
})

// 5. And a major that has both pool types.
await section('QUOTE 100 USDm -> EURm (has both Virtual and FPMM)', async () => {
  const out = await mento.quotes.getAmountOut(USDm as any, EURm as any, parseUnits('100', 18))
  const raw = typeof out === 'bigint' ? out : BigInt((out as any)?.amountOut ?? (out as any)?.amount)
  console.log(`100 USDm => ${formatUnits(raw, 18)} EURm`)
})
