/**
 * Last-known rate store.
 *
 * Naira and every other FX pair go dark from Friday 21:00 to Sunday 21:00 UTC.
 * An agent that asks during those 48 hours deserves better than "no". It gets
 * the last rate we actually observed, stamped with how old it is, and clearly
 * marked as stale so it is never mistaken for live pricing.
 *
 * Persisted to disk so a restart does not erase the history — a cache that
 * empties on deploy is worthless precisely when the market is shut.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CACHE_FILE = process.env.COWRIE_CACHE ?? '.cache/rates.json'

export interface CachedRate {
  from: string
  to: string
  rate: number
  /** When we observed it, ISO 8601. */
  observed_at: string
}

type Store = Record<string, CachedRate>

let store: Store = load()

function key(from: string, to: string) {
  return `${from}/${to}`
}

function load(): Store {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store
  } catch {
    return {} // no cache yet, or unreadable — start clean rather than crash
  }
}

function persist() {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
  } catch {
    // A read-only filesystem must not take the service down; the in-memory
    // cache still works for the life of the process.
  }
}

/** Record a rate we just saw live. Also stores the inverse — it costs nothing. */
export function remember(from: string, to: string, rate: number) {
  const observed_at = new Date().toISOString()
  store[key(from, to)] = { from, to, rate, observed_at }
  if (rate > 0) {
    store[key(to, from)] = { from: to, to: from, rate: 1 / rate, observed_at }
  }
  persist()
}

export interface StaleRate extends CachedRate {
  /** How old the observation is, in seconds. */
  age_seconds: number
}

/** The last rate we saw for a pair, or null if we have never seen one. */
export function recall(from: string, to: string): StaleRate | null {
  const hit = store[key(from, to)]
  if (!hit) return null
  return {
    ...hit,
    age_seconds: Math.round((Date.now() - new Date(hit.observed_at).getTime()) / 1000),
  }
}

/** Everything we hold, for the /pairs endpoint. */
export function allCached(): CachedRate[] {
  return Object.values(store)
}
