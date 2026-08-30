/**
 * Vercel entry point.
 *
 * Vercel's Node runtime passes the same (req, res) objects node:http uses, so
 * this is a thin adapter over the shared handler — no duplicated routing.
 * vercel.json rewrites every path here, which is why one function serves the
 * whole API instead of a file per endpoint.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handle } from '../src/handler.js'

export default async function (req: IncomingMessage, res: ServerResponse) {
  await handle(req, res)
}
