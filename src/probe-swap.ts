/**
 * Swap-builder probe.
 *
 * Before writing POST /swap we need to know exactly what
 * mento.swap.buildSwapParams returns — the published docs have misdescribed
 * this SDK twice already, so the object in front of us is the only source
 * worth trusting.
 *
 * Uses USDm -> USDC deliberately: it is dollar-to-dollar, crosses no FX rate,
 * and therefore prices even while global FX markets are shut.
 *
 * Read-only. Builds transaction parameters but signs and sends nothing.
 * Run: npm run probe:swap
 */
import { createRequire } from 'node:module'
import { parseUnits } from 'viem'

const require = createRequire(import.meta.url)
const { Mento, ChainId, deadlineFromMinutes } = require('@mento-protocol/mento-sdk')

const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2)

const USDm = '0x765DE816845861e75A25fCA122bb6898B8B1282a'
const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'
const WALLET = '0xc3A2AE793B4aCC88620E538201913A7F042edA0D'

const mento = await Mento.create(ChainId.CELO)
console.log('connected\n')

console.log('=== SWAP SERVICE METHODS ===')
console.log(
  Object.getOwnPropertyNames(Object.getPrototypeOf(mento.swap))
    .filter((m) => m !== 'constructor')
    .join(', ')
)

console.log('\n=== deadlineFromMinutes ===')
console.log(typeof deadlineFromMinutes, deadlineFromMinutes ? deadlineFromMinutes(5) : 'MISSING')

console.log('\n=== buildSwapParams: 10 USDm -> USDC ===')
try {
  const params = await mento.swap.buildSwapParams(
    USDm,
    USDC,
    parseUnits('10', 18),
    WALLET,
    { slippageTolerance: 0.5, deadline: deadlineFromMinutes(5) }
  )
  console.log(dump(params))

  // What we most need to know: does it hand back ready-to-send transaction
  // objects (to/data/value), or something we must assemble ourselves? And is
  // an ERC-20 approval included, since Mento's broker must be allowed to move
  // the input token before any swap can succeed?
  console.log('\n--- shape analysis ---')
  console.log('top-level keys:', Object.keys(params ?? {}).join(', '))
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v && typeof v === 'object') {
      console.log(`  ${k}: { ${Object.keys(v).join(', ')} }`)
    } else {
      console.log(`  ${k}: ${String(v)}`)
    }
  }
} catch (err) {
  console.log(`FAILED: ${(err as Error).message.split('\n').slice(0, 3).join(' | ')}`)
}
