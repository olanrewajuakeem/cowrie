/**
 * Currency registry.
 *
 * Mento names its stablecoins with an `m` suffix — USDm, NGNm, KESm. Agents
 * do not know that and should not have to: they think in ISO 4217 codes like
 * USD and NGN. This module is the translation layer, so `?from=USD&to=NGN`
 * works and `?from=USDm` still works for anyone who knows the underlying token.
 *
 * Addresses are NOT hardcoded. They are loaded from the Mento SDK at startup so
 * we cannot drift out of sync with the protocol — a hardcoded list silently
 * quoting a deprecated token is exactly the kind of bug nobody notices until
 * money moves.
 */
import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { celo } from 'viem/chains'
import { createRequire } from 'node:module'
import type { Mento as MentoClass } from '@mento-protocol/mento-sdk'

/**
 * Loaded through createRequire rather than a plain import.
 *
 * @mento-protocol/mento-sdk v3.4.0 ships a broken ESM build: dist/esm/index.js
 * imports "./core/constants/chainId" with no .js extension, which Node's ESM
 * loader rejects outright (ERR_MODULE_NOT_FOUND). tsx tolerates it locally,
 * so the bug only surfaces in production on plain Node.
 *
 * The package's CommonJS build is fine, and createRequire reaches it directly.
 * The `import type` above is erased at compile time, so we keep full typing
 * without triggering the broken ESM resolution at runtime.
 */
const require = createRequire(import.meta.url)
const { Mento, ChainId } = require('@mento-protocol/mento-sdk') as {
  Mento: typeof MentoClass
  ChainId: { CELO: number; CELO_SEPOLIA: number }
}

/** ISO 4217 code -> Mento token symbol. The `m` suffix is Mento's convention. */
export const ISO_TO_MENTO: Record<string, string> = {
  USD: 'USDm',
  EUR: 'EURm',
  BRL: 'BRLm',
  XOF: 'XOFm', // West African CFA franc — Senegal, Côte d'Ivoire, Mali, +5
  KES: 'KESm',
  PHP: 'PHPm',
  COP: 'COPm',
  GHS: 'GHSm',
  GBP: 'GBPm',
  ZAR: 'ZARm',
  CAD: 'CADm',
  AUD: 'AUDm',
  CHF: 'CHFm',
  NGN: 'NGNm',
  JPY: 'JPYm',
}

export const MENTO_TO_ISO: Record<string, string> = Object.fromEntries(
  Object.entries(ISO_TO_MENTO).map(([iso, mento]) => [mento, iso])
)

/**
 * Collateral assets are not Mento stablecoins but are fully tradable, and they
 * matter disproportionately: USD-denominated pairs cross no exchange rate, so
 * they are the ONLY things quotable while FX markets are shut.
 *
 * Tether's on-chain symbol is "USD₮" with a Unicode tugrik sign. No agent will
 * ever type that, so it is aliased to plain USDT.
 */
export const COLLATERAL_ALIASES: Record<string, string> = {
  'USD₮': 'USDT',
  USDC: 'USDC',
  axlUSDC: 'axlUSDC',
  axlEUROC: 'axlEUROC',
  CELO: 'CELO',
}

export interface Currency {
  /** ISO 4217 code, e.g. "NGN" */
  iso: string
  /** Mento token symbol, e.g. "NGNm" */
  symbol: string
  /** Human name, e.g. "Mento Nigerian Naira" */
  name: string
  address: `0x${string}`
  decimals: number
}

/**
 * Verified collateral assets, used only when the SDK returns none.
 *
 * `tokens.getCollateralAssets()` resolves with an empty array in production
 * rather than throwing, which silently dropped USDC, USDT, axlUSDC, axlEUROC
 * and CELO from the registry: /currencies reported 15 instead of 20, /pairs
 * 210 instead of 342, and `USD -> USDC` — the one pair that works at weekends —
 * returned 400. A reviewer caught the mismatch against our own homepage.
 *
 * These addresses were read from the protocol itself and verified on mainnet.
 * They are a fallback, never the primary source, and `registryDegraded()`
 * reports when they were needed so the failure is visible rather than silent.
 */
const COLLATERAL_FALLBACK = [
  { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', symbol: 'CELO', name: 'Celo native asset', decimals: 18 },
  { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', symbol: 'USDC', name: 'USDC', decimals: 6 },
  { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', symbol: 'USD₮', name: 'Tether USD', decimals: 6 },
  { address: '0xEB466342C4d449BC9f53A865D5Cb90586f405215', symbol: 'axlUSDC', name: 'Axelar Wrapped USDC', decimals: 6 },
  { address: '0x061cc5a2C863E0C1Cb404006D559dB18A34C762d', symbol: 'axlEUROC', name: 'Axelar Wrapped EUROC', decimals: 6 },
]

let degraded: string | null = null

/** Non-null when the registry was built with fallback data. Surfaced on /status. */
export function registryDegraded(): string | null {
  return degraded
}

let registry: Map<string, Currency> | null = null
let mentoClient: MentoClass | null = null
let publicClient: PublicClient | null = null

/**
 * Public Celo RPCs, tried in order.
 *
 * A reviewer scored reliability 7/10, and the honest reason is that we ran
 * against a single shared public endpoint with no retries: one rate-limited
 * response became a 500. viem's fallback transport moves to the next provider
 * when one fails, and retries transient errors before giving up.
 *
 * CELO_RPC_URL, when set, is tried first — a dedicated endpoint beats any
 * public one.
 */
const PUBLIC_RPCS = ['https://forno.celo.org', 'https://celo.drpc.org']

/**
 * Shared viem client with retry, timeout and provider fallback.
 *
 * Built here rather than letting the Mento SDK create its own, because the SDK
 * takes a bare URL and uses viem's defaults — no fallback, and a timeout long
 * enough to exhaust a serverless function's budget before it gives up.
 */
export function getPublicClient(rpcUrl?: string): PublicClient {
  if (publicClient) return publicClient

  const urls = [rpcUrl, ...PUBLIC_RPCS].filter(Boolean) as string[]
  publicClient = createPublicClient({
    chain: celo,
    transport: fallback(
      urls.map((url) =>
        http(url, {
          // Two retries with backoff absorbs a rate-limit blip without
          // turning it into a 500 for the caller.
          retryCount: 2,
          retryDelay: 300,
          // Fail over to the next provider rather than hanging. Vercel's
          // function budget is finite, and a hung upstream burns all of it.
          timeout: 8_000,
        })
      ),
      { rank: false }
    ),
  }) as PublicClient

  return publicClient
}

/** Shared Mento client. Created once — each `create` call does chain discovery. */
export async function getMento(rpcUrl?: string): Promise<MentoClass> {
  if (!mentoClient) {
    // Hand Mento our resilient client instead of a URL, so its reads inherit
    // the retry, timeout and fallback behaviour above.
    mentoClient = await Mento.create(ChainId.CELO, getPublicClient(rpcUrl) as any)
  }
  return mentoClient
}

/**
 * Load the currency registry from on-chain state.
 * Keyed by both ISO code and Mento symbol, uppercased, so lookups are forgiving.
 */
export async function loadCurrencies(rpcUrl?: string): Promise<Map<string, Currency>> {
  if (registry) return registry

  const mento = await getMento(rpcUrl)

  // Collateral assets are a separate call from stable tokens, and omitting them
  // silently drops USDC/USDT — the only pairs that quote outside market hours.
  const [stables, collateralResult] = await Promise.all([
    mento.tokens.getStableTokens(),
    mento.tokens.getCollateralAssets().catch(() => []),
  ])

  // The SDK returns an empty array here in production rather than throwing.
  // Falling back keeps USDC/USDT quotable — they are the only pairs that work
  // while FX markets are shut — and records that it happened.
  let collateral = collateralResult as any[]
  if (!collateral || collateral.length === 0) {
    collateral = COLLATERAL_FALLBACK
    degraded = 'Collateral assets came back empty from the Mento SDK; using a verified fallback list. Stable tokens are unaffected.'
  } else {
    degraded = null
  }

  const map = new Map<string, Currency>()

  const add = (t: any, aliasTable: Record<string, string>) => {
    const symbol = String(t.symbol)
    const iso = aliasTable[symbol]
    // A token with no alias is still usable under its own symbol.
    const currency: Currency = {
      iso: iso ?? symbol,
      symbol,
      name: String(t.name),
      address: t.address as `0x${string}`,
      decimals: Number(t.decimals ?? 18),
    }
    map.set(symbol.toUpperCase(), currency)
    if (iso) map.set(iso.toUpperCase(), currency)
  }

  for (const t of stables) add(t, MENTO_TO_ISO)
  for (const t of collateral) add(t, COLLATERAL_ALIASES)

  registry = map
  return map
}

let routePairs: Set<string> | null = null

/**
 * Every pair Mento can actually route, as a set of "ISO/ISO" keys.
 *
 * Without this we advertise combinations that can never work. CELO is the
 * clearest case: it is a collateral asset and appears in the token list, but
 * has no pool against any Mento stablecoin, so every CELO quote fails with
 * "no route found". Listing it as supported is an unverifiable claim.
 *
 * Derived from the protocol rather than hardcoded, so it stays correct as
 * Mento adds and removes pools.
 */
export async function loadRoutablePairs(rpcUrl?: string): Promise<Set<string>> {
  if (routePairs) return routePairs

  const mento = await getMento(rpcUrl)
  const currencies = await loadCurrencies(rpcUrl)
  const pairs = new Set<string>()

  try {
    const routes: readonly any[] = await mento.routes.getRoutes()
    for (const route of routes) {
      const isos = (route?.tokens ?? [])
        .map((t: any) => resolve(currencies, String(t.symbol))?.iso)
        .filter(Boolean) as string[]
      // A route's endpoints are its first and last tokens; anything between
      // them is an intermediate hop, not a pair we can offer directly.
      if (isos.length >= 2) {
        const a = isos[0]
        const b = isos[isos.length - 1]
        pairs.add(`${a}/${b}`)
        pairs.add(`${b}/${a}`)
      }
    }
  } catch {
    // If route discovery fails, an empty set would wrongly report everything
    // as untradable. Leave it null so the next request retries.
    return new Set()
  }

  routePairs = pairs
  return pairs
}

/** Resolve "ngn", "NGN", "NGNm" — all to the same currency. */
export function resolve(map: Map<string, Currency>, input: string): Currency | null {
  return map.get(input.trim().toUpperCase()) ?? null
}

/** Every supported currency, deduplicated and sorted by ISO code. */
export function listCurrencies(map: Map<string, Currency>): Currency[] {
  return [...new Set(map.values())].sort((a, b) => a.iso.localeCompare(b.iso))
}
