/**
 * Discovery probe — not part of the service.
 *
 * Reads live Mento state from Celo mainnet so we can design the quote API
 * around what the protocol actually returns, rather than what we assume.
 * Every call here is a free read; nothing is signed and no gas is spent.
 *
 * Each section is independently guarded so one failure still leaves us with
 * the output of every other section. Run: npm run probe
 */
import { Mento, ChainId } from '@mento-protocol/mento-sdk'
import { parseUnits, formatUnits } from 'viem'

/** JSON.stringify blows up on bigint, which is most of what an SDK like this returns. */
const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n=== ${title} ===`)
  try {
    await fn()
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`)
  }
}

const mento = await Mento.create(ChainId.CELO)
console.log('connected to Celo mainnet (chain 42220)')

// What methods actually exist? The published docs disagreed with the shipped
// package, so trust the object in front of us over anything written down.
await section('AVAILABLE METHODS', async () => {
  for (const svc of ['tokens', 'pools', 'routes', 'quotes', 'trading'] as const) {
    const obj = (mento as any)[svc]
    if (!obj) {
      console.log(`${svc}: MISSING`)
      continue
    }
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(obj)).filter(
      (m) => m !== 'constructor'
    )
    console.log(`${svc}: ${methods.join(', ')}`)
  }
})

let stables: any[] = []

await section('STABLE TOKENS', async () => {
  stables = await mento.tokens.getStableTokens()
  console.log(`${stables.length} stable tokens`)
  console.log(dump(stables))
})

await section('COLLATERAL ASSETS', async () => {
  const collateral = await mento.tokens.getCollateralAssets()
  console.log(dump(collateral))
})

// Pick a real remittance corridor: a dollar stablecoin into a local-currency one.
const find = (sym: string) =>
  stables.find((t) => String(t?.symbol ?? '').toLowerCase() === sym.toLowerCase())

const from = find('USDm')
const to = find('NGNm')

if (!from || !to) {
  console.log('\ncUSD/cKES not found by symbol — check the dump above for real field names.')
  console.log('symbols seen:', stables.map((t) => t?.symbol).join(', '))
} else {
  console.log(`\nfrom: ${from.symbol} ${from.address} (${from.decimals} dp)`)
  console.log(`to:   ${to.symbol} ${to.address} (${to.decimals} dp)`)

  const amountIn = parseUnits('100', from.decimals ?? 18)

  await section('QUOTE: 100 USDm -> NGNm', async () => {
    const quote = await mento.quotes.getAmountOut(from.address, to.address, amountIn)
    console.log('raw:', dump(quote))

    // May be a bare bigint or a wrapper object — handle both.
    const raw = typeof quote === 'bigint' ? quote : (quote as any)?.amountOut ?? (quote as any)?.amount
    if (raw !== undefined) {
      const human = formatUnits(BigInt(raw), to.decimals ?? 18)
      console.log(`100 USDm => ${human} NGNm  (rate ${Number(human) / 100})`)
    }
  })

  await section('ROUTE', async () => {
    console.log(dump(await mento.routes.findRoute(from.address, to.address)))
  })

  await section('TRADABLE?', async () => {
    console.log(dump(await mento.trading.isPairTradable(from.address, to.address)))
  })
}

/**
 * Coverage sweep — the most important output here.
 *
 * KESm reported isPairTradable=true but reverted on getAmountOut with
 * "no valid median", so tradability and quotability are NOT the same thing.
 * The only way to know what this product can actually sell is to quote every
 * corridor and see which ones answer.
 */
await section('COVERAGE SWEEP: 100 USDm -> every currency', async () => {
  const usd = find('USDm')
  if (!usd) return console.log('USDm missing, cannot sweep')

  const amountIn = parseUnits('100', 18)
  const ok: string[] = []
  const dead: string[] = []

  for (const t of stables) {
    if (t.address === usd.address) continue
    try {
      const q = await mento.quotes.getAmountOut(usd.address, t.address, amountIn)
      const raw = typeof q === 'bigint' ? q : (q as any)?.amountOut ?? (q as any)?.amount
      const human = Number(formatUnits(BigInt(raw), t.decimals ?? 18))
      console.log(`  OK    USDm -> ${t.symbol.padEnd(5)} rate ${(human / 100).toFixed(4)}`)
      ok.push(t.symbol)
    } catch (err) {
      // Print the FULL first line — the truncated version hid a reopen time.
      const reason = (err as Error).message.split('\n')[0]
      console.log(`  DEAD  USDm -> ${t.symbol.padEnd(5)} ${reason}`)
      dead.push(t.symbol)
    }
  }

  console.log(`\nquotable (${ok.length}): ${ok.join(', ') || 'none'}`)
  console.log(`dead     (${dead.length}): ${dead.join(', ') || 'none'}`)
})

/**
 * Market-hours introspection.
 *
 * Everything failed above because global FX markets are shut on Saturdays.
 * The question that decides the product: can we detect "closed" and the
 * reopen time from on-chain state, or only by catching a revert string?
 * Structured state is far better than parsing English error messages.
 */
await section('TRADING MODE / MARKET STATE', async () => {
  const usd = find('USDm')
  const ngn = find('NGNm')
  if (!usd || !ngn) return console.log('pair missing')

  const rateFeedId = await mento.trading.getPoolRateFeedId({
    token0: usd.address,
    token1: ngn.address,
  } as any).catch((e: Error) => `FAILED: ${e.message.split('\n')[0]}`)
  console.log('rateFeedId:', dump(rateFeedId))

  if (typeof rateFeedId === 'string' && rateFeedId.startsWith('0x')) {
    const mode = await mento.trading
      .getRateFeedTradingMode(rateFeedId)
      .catch((e: Error) => `FAILED: ${e.message.split('\n')[0]}`)
    console.log('tradingMode:', dump(mode))
  }

  const status = await mento.trading
    .getPoolTradabilityStatus({ token0: usd.address, token1: ngn.address } as any)
    .catch((e: Error) => `FAILED: ${e.message.split('\n')[0]}`)
  console.log('tradabilityStatus:', dump(status))

  const limits = await mento.trading
    .getPoolTradingLimits({ token0: usd.address, token1: ngn.address } as any)
    .catch((e: Error) => `FAILED: ${e.message.split('\n')[0]}`)
  console.log('tradingLimits:', dump(limits))
})

