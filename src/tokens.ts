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

let registry: Map<string, Currency> | null = null
let mentoClient: MentoClass | null = null

/** Shared Mento client. Created once — each `create` call does chain discovery. */
export async function getMento(rpcUrl?: string): Promise<MentoClass> {
  if (!mentoClient) {
    mentoClient = rpcUrl
      ? await Mento.create(ChainId.CELO, rpcUrl)
      : await Mento.create(ChainId.CELO)
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
  const [stables, collateral] = await Promise.all([
    mento.tokens.getStableTokens(),
    mento.tokens.getCollateralAssets(),
  ])

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

/** Resolve "ngn", "NGN", "NGNm" — all to the same currency. */
export function resolve(map: Map<string, Currency>, input: string): Currency | null {
  return map.get(input.trim().toUpperCase()) ?? null
}

/** Every supported currency, deduplicated and sorted by ISO code. */
export function listCurrencies(map: Map<string, Currency>): Currency[] {
  return [...new Set(map.values())].sort((a, b) => a.iso.localeCompare(b.iso))
}
