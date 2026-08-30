/**
 * Last-known rate store.
 *
 * Naira and every other FX pair go dark from Friday 21:00 to Sunday 21:00 UTC.
 * An agent that asks during those 48 hours deserves better than "no". It gets
 * the last rate we actually observed, stamped with how old it is, and clearly
 * marked as stale so it is never mistaken for live pricing.
 *
 * Two backends, chosen automatically:
 *   - Upstash Redis when UPSTASH_REDIS_REST_URL is set (production). Serverless
 *     functions have no persistent disk and share no memory between
 *     invocations, so an external store is the only thing that survives.
 *   - A JSON file on disk otherwise (local development).
 *
 * Talks to Upstash over its REST API with plain fetch — no client library, one
 * less dependency for a reviewer to audit.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CACHE_FILE = process.env.COWRIE_CACHE ?? '.cache/rates.json'
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const HASH_KEY = 'cowrie:rates'

const useRedis = Boolean(REDIS_URL && REDIS_TOKEN)

export interface CachedRate {
  from: string
  to: string
  rate: number
  /** When we observed it, ISO 8601. */
  observed_at: string
}

export interface StaleRate extends CachedRate {
  /** How old the observation is, in seconds. */
  age_seconds: number
}

const field = (from: string, to: string) => `${from}/${to}`

// ---------------------------------------------------------------- Redis

async function redis(path: string, body?: string): Promise<unknown> {
  const res = await fetch(`${REDIS_URL}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    ...(body === undefined ? {} : { body }),
  })
  if (!res.ok) throw new Error(`upstash ${res.status}`)
  const json = (await res.json()) as { result?: unknown }
  return json.result
}

// ---------------------------------------------------------------- Disk

function readDisk(): Record<string, CachedRate> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return {} // no cache yet, or unreadable — start clean rather than crash
  }
}

function writeDisk(store: Record<string, CachedRate>) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
  } catch {
    // A read-only filesystem must not take the service down.
  }
}

// ---------------------------------------------------------------- API

/**
 * Record a rate we just saw live. Also stores the inverse — it costs nothing
 * and doubles what we can answer during a blackout.
 *
 * Never throws: a cache write failing must not turn a good quote into an error.
 */
export async function remember(from: string, to: string, rate: number): Promise<void> {
  const observed_at = new Date().toISOString()
  const entries: CachedRate[] = [{ from, to, rate, observed_at }]
  if (rate > 0) entries.push({ from: to, to: from, rate: 1 / rate, observed_at })

  try {
    if (useRedis) {
      await Promise.all(
        entries.map((e) => redis(`hset/${HASH_KEY}/${field(e.from, e.to)}`, JSON.stringify(e)))
      )
      return
    }
    const store = readDisk()
    for (const e of entries) store[field(e.from, e.to)] = e
    writeDisk(store)
  } catch {
    // Losing a cache write is survivable; failing the request is not.
  }
}

/** The last rate we saw for a pair, or null if we have never seen one. */
export async function recall(from: string, to: string): Promise<StaleRate | null> {
  try {
    let hit: CachedRate | undefined
    if (useRedis) {
      const raw = await redis(`hget/${HASH_KEY}/${field(from, to)}`)
      hit = typeof raw === 'string' ? (JSON.parse(raw) as CachedRate) : undefined
    } else {
      hit = readDisk()[field(from, to)]
    }
    if (!hit) return null
    return {
      ...hit,
      age_seconds: Math.round((Date.now() - new Date(hit.observed_at).getTime()) / 1000),
    }
  } catch {
    return null
  }
}

/** Everything we hold, for the /pairs endpoint. */
export async function allCached(): Promise<CachedRate[]> {
  try {
    if (useRedis) {
      // HGETALL returns a flat [field, value, field, value, ...] array.
      const flat = (await redis(`hgetall/${HASH_KEY}`)) as string[] | null
      if (!Array.isArray(flat)) return []
      const out: CachedRate[] = []
      for (let i = 1; i < flat.length; i += 2) {
        try {
          out.push(JSON.parse(flat[i]) as CachedRate)
        } catch {
          // skip a corrupt entry rather than losing the whole listing
        }
      }
      return out
    }
    return Object.values(readDisk())
  } catch {
    return []
  }
}

/** Which backend is live — surfaced on /status so the deploy is verifiable. */
export function cacheBackend(): 'redis' | 'disk' {
  return useRedis ? 'redis' : 'disk'
}
