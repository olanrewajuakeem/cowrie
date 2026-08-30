/**
 * Local development server.
 *
 * Production runs on Vercel via api/index.ts; both call the same `handle`
 * function, so what you test here is what ships.
 */
import { createServer } from 'node:http'
import { handle } from './handler.js'
import { marketState } from './market.js'
import { cacheBackend } from './cache.js'

const PORT = Number(process.env.PORT ?? 8080)

createServer((req, res) => {
  handle(req, res).catch((err) => {
    // handle() catches its own errors; this is the last line of defence so a
    // bug can never leave a socket hanging open.
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'internal_error', message: String(err) } }))
  })
}).listen(PORT, () => {
  console.log(`Cowrie listening on http://localhost:${PORT}`)
  console.log(`cache backend: ${cacheBackend()}`)
  const m = marketState()
  console.log(
    m.open
      ? `FX market OPEN (closes ${m.closes_at})`
      : `FX market CLOSED (reopens ${m.reopens_at}, in ${m.retry_after}s)`
  )
})
