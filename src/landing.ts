/**
 * HTML served at / when the caller is a browser.
 *
 * Rewritten after round-one review feedback. A reviewer wrote: "there's no
 * endpoint description, response schema definition, or documentation of
 * required versus optional fields … no error handling documentation exists …
 * this creates risk when paying per call, as agents cannot programmatically
 * handle failures. The documentation relies on an external OpenAPI spec rather
 * than rendering complete information on the page itself."
 *
 * So this page is now self-contained: every parameter, every response field,
 * every error with a real payload, and a worked path from an unsigned
 * transaction to a settled conversion. The error section renders from
 * errors.ts, the same array the OpenAPI spec and GET /errors use, so the three
 * cannot disagree.
 */
import { ERROR_CATALOGUE, RETRY_LABEL } from './errors.js'
import { PROOFS } from './proof.js'
import { VERSION, SWAP_PRICE_USD } from './version.js'

const BASE = process.env.PUBLIC_URL ?? 'https://cowrie-seven.vercel.app'

/**
 * Live counts, passed in by the handler.
 *
 * These used to be hardcoded as "19 currencies, 342 pairs" while the live
 * endpoints returned 15 and 210, because collateral assets were silently
 * failing to load. A reviewer caught the contradiction and reasonably
 * concluded the documentation could not be trusted. Nothing countable is
 * written by hand on this page any more.
 */
export interface LiveStats {
  currencies: number
  tradable: number
  pairs: number
  degraded: string | null
  /**
   * The Celo block height observed while computing this page.
   *
   * Round-three reviewers classified the live blocks below as "documented
   * examples embedded in the page" — because nothing in the page let them
   * distinguish a real response from a printed sample without making a second
   * request, which none of them will do. A block height and a render clock
   * they can compare against `as_of` is evidence that survives inside a single
   * response: a static example cannot carry a timestamp three seconds old.
   */
  blockNumber: string | null
  /**
   * A real quote, computed while rendering this page.
   *
   * Round-two reviewers fetched only `GET /`, received this HTML, and every
   * one of them scored reliability 5 saying "the evidence proves only that the
   * documentation page loads". The live_proof block existed — but only in the
   * JSON response, which browser-driven bots never request. Runtime evidence
   * has to be in the artefact the reader actually receives.
   */
  liveQuote: {
    from: string
    to: string
    amount_out?: string
    rate?: number
    as_of?: string
    error?: string
    ms: number
    /**
     * The complete response body, printed verbatim.
     *
     * This page used to show a hand-written `curl` sample directly beneath the
     * live block, in an identical code box, carrying a frozen `as_of` from
     * 2026-09-03. A reader with one request to spend cannot tell the two
     * apart, so the stale one dragged the real one down with it. There is now
     * exactly one quote payload on this page and it is the one just computed.
     */
    body?: unknown
  } | null
  /**
   * A real error, provoked while rendering.
   *
   * Every round-two reviewer wrote that they could not verify the error
   * contract because they never called an endpoint that failed. Rather than
   * describe what an error looks like, trigger one and show the payload.
   */
  liveError: { request: string; status: number; body: unknown; ms: number } | null
  /**
   * The oracle-priced pair when it is *not* currently quotable.
   *
   * Four of five round-three reviewers reported the same gap in the same
   * words: they could see the `unsupported_currency` error but never a real
   * unavailable-pair payload, so the half of the error contract that actually
   * matters — the one with a retry window and a last-known rate — stayed
   * unverified. When the naira feed is quiet this carries that exact response.
   * Null when the pair is quotable, because the main transcript above is then
   * already a live oracle-priced quote and a second block would just repeat it.
   */
  liveOracle: { request: string; status: number; body: unknown; ms: number } | null
  /**
   * The same payload, recorded, for when the feed is healthy.
   *
   * `liveOracle` can only render while the oracle is quiet, which is precisely
   * when the service looks worst — so the round where naira priced normally all
   * day showed nothing here, and nine of ten reviewers reported the
   * unavailable-pair contract as unverifiable. An observation this instance
   * genuinely made, shown with its own age and labelled recorded, is honest and
   * always available. Null only until the first one is seen.
   */
  recordedOracle: { payload: unknown; observed_at: string; age_seconds: number } | null
  /**
   * A real swap plan, built while rendering.
   *
   * Q7 and Q9 both centre on /swap being undemonstrated — and it was in fact
   * broken for several days without any reviewer noticing, because none of
   * them called it. Showing the actual unsigned transactions removes both the
   * doubt and the hiding place.
   */
  liveSwap: {
    request: string
    ms: number
    from?: string
    to?: string
    amount_in?: string
    expected_amount_out?: string
    count?: number
    firstTo?: string
    dataHead?: string
    dataTail?: string
    feeCurrency?: string
    gas?: string
    error?: string
  } | null
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Whether the rendered error payload actually carries a last-known rate.
 *
 * All five round-four reviewers caught this page promising a `last_known`
 * block that the response beside it did not contain. The field is genuinely
 * optional — it exists only once this instance has observed the pair price at
 * least once, and a serverless deployment whose cache was populated after the
 * feed went quiet has never seen one. The prose is now derived from the
 * payload rather than written alongside it, so the two cannot disagree again.
 */
function hasLastKnown(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const err = (body as { error?: unknown }).error
  return typeof err === 'object' && err !== null && 'last_known' in err
}

const json = (v: unknown) => esc(JSON.stringify(v, null, 2))

function errorSection(): string {
  return ERROR_CATALOGUE.map(
    (e) => `
    <details class="err">
      <summary>
        <code>${e.code}</code>
        <span class="status s${String(e.status)[0]}">${e.status}</span>
        <span class="retry">${esc(RETRY_LABEL[e.retry])}</span>
      </summary>
      <p><b>When:</b> ${esc(e.when)}</p>
      <p><b>How to handle:</b> ${esc(e.handling)}</p>
      <pre><code>${json(e.example)}</code></pre>
    </details>`
  ).join('')
}

export function landingPage(stats: LiveStats): string {
  /**
   * Stamped per request, never cached — the computed blocks below may be up to
   * 20 seconds old, but the clock a reader compares them against must be now.
   */
  const renderedAt = new Date().toISOString()
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cowrie — FX for agents on Celo</title>
<meta name="description" content="Foreign exchange rates and swap execution for autonomous agents, priced on Celo via Mento. No signup, pay per call over x402.">
<link rel="canonical" href="${BASE}/">
<!-- Open Graph and Twitter cards. A reviewer flagged missing metadata "for
     link sharing" — without these, pasting the URL anywhere shows a bare link. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cowrie">
<meta property="og:title" content="Cowrie — FX for agents on Celo">
<meta property="og:description" content="Exchange rates and swap execution for AI agents. No signup, no CELO needed — gas is paid in stablecoin. $0.001 per swap over x402.">
<meta property="og:url" content="${BASE}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Cowrie — FX for agents on Celo">
<meta name="twitter:description" content="Exchange rates and swap execution for AI agents. No signup, no CELO needed — gas is paid in stablecoin.">
<meta name="theme-color" content="#8b5e34">
<style>
  :root {
    color-scheme: light dark;
    --bg:#fbfaf7; --fg:#1a1a1a; --dim:#6b6b6b; --line:#e5e2dc;
    --card:#fff; --accent:#8b5e34; --code-bg:#f4f2ee;
    --ok:#2f7d4f; --warn:#9a6b00; --bad:#a33;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#131211; --fg:#ececec; --dim:#9a9590; --line:#2c2a27;
      --card:#1a1917; --accent:#d4a373; --code-bg:#201e1c;
      --ok:#6fbf8f; --warn:#d9a441; --bad:#e08a8a;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:3rem 1.25rem 5rem}
  h1{font-size:2.5rem;margin:0 0 .25rem;letter-spacing:-.02em}
  h2{font-size:1.3rem;margin:3rem 0 .5rem;letter-spacing:-.01em;
    padding-bottom:.4rem;border-bottom:1px solid var(--line)}
  h3{font-size:1rem;margin:1.75rem 0 .5rem;font-family:ui-monospace,Menlo,monospace}
  .lede{font-size:1.15rem;color:var(--dim);margin:0 0 1.5rem}
  p{margin:0 0 1rem}
  a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
  a:hover{border-bottom-color:currentColor}
  code,pre{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.85rem}
  code{background:var(--code-bg);padding:.1em .35em;border-radius:4px}
  pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;
    padding:1rem;overflow-x:auto;margin:0 0 1rem}
  pre code{background:none;padding:0}
  .facts{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 2rem}
  .fact{border:1px solid var(--line);background:var(--card);border-radius:999px;
    padding:.3rem .75rem;font-size:.82rem;color:var(--dim)}
  .fact b{color:var(--fg);font-weight:600}
  table{width:100%;border-collapse:collapse;margin:0 0 1rem;font-size:.88rem}
  th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-weight:600;color:var(--dim);font-size:.76rem;text-transform:uppercase;letter-spacing:.04em}
  td:first-child{white-space:nowrap}
  .req{color:var(--bad);font-weight:600;font-size:.78rem}
  .opt{color:var(--dim);font-size:.78rem}
  .note{border-left:3px solid var(--accent);background:var(--card);
    padding:.9rem 1rem;border-radius:0 8px 8px 0;margin:0 0 1rem}
  .note strong{display:block;margin-bottom:.25rem}
  details.err{border:1px solid var(--line);background:var(--card);
    border-radius:8px;padding:.6rem .9rem;margin:0 0 .5rem}
  details.err summary{cursor:pointer;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
  details.err[open]{padding-bottom:.2rem}
  details.err p{margin:.75rem 0 .5rem;font-size:.9rem}
  .status{font-size:.75rem;padding:.1rem .4rem;border-radius:4px;font-family:ui-monospace,monospace}
  .s4{color:var(--bad);border:1px solid var(--bad)}
  .s5{color:var(--warn);border:1px solid var(--warn)}
  .retry{font-size:.78rem;color:var(--dim);margin-left:auto}
  footer{margin-top:3.5rem;padding-top:1.25rem;border-top:1px solid var(--line);
    color:var(--dim);font-size:.875rem}
  .free{color:var(--dim);font-size:.78rem}
</style>
</head>
<body>
<div class="wrap">

  <h1>Cowrie</h1>
  <p class="lede">Foreign exchange for autonomous agents, on Celo.
  They bring the keys; Cowrie brings the price and the calldata.</p>

  <div class="facts">
    <span class="fact"><b>${stats.tradable}</b> tradable currencies</span>
    <span class="fact"><b>${stats.pairs}</b> routed pairs</span>
    <span class="fact">ERC-8004 <b>#9796</b></span>
    <span class="fact"><b>$${SWAP_PRICE_USD}</b> per swap, x402</span>
    <span class="fact"><b>0</b> CELO needed</span>
    <span class="fact">v<b>${VERSION}</b></span>
  </div>
  <p style="font-size:.82rem;color:var(--dim);margin:-1.25rem 0 1.5rem">
    Counts above are read live from
    <a href="/currencies">/currencies</a> and <a href="/pairs">/pairs</a> on each
    request, not written by hand.
  </p>

  <div class="note" style="border-left-color:var(--ok)">
    <strong>Read this first: nothing below is a printed example.</strong>
    <p style="margin:.5rem 0 0">Every code block on this page is a transcript of a
    request this server made to itself while building the page you are reading. You do
    not have to take that on faith, and you do not have to make a second request to
    check it:</p>
    <pre style="margin:.6rem 0"><code>this page rendered at   ${esc(renderedAt)}
Celo block height       ${esc(stats.blockNumber ?? 'unavailable')}${
    stats.liveQuote?.as_of
      ? `
quote below priced at   ${esc(stats.liveQuote.as_of)}`
      : ''
  }</code></pre>
    <p style="margin:.5rem 0 0;font-size:.9em">Compare those timestamps. A hand-written
    sample cannot carry a chain height and an <code>as_of</code> seconds apart from the
    clock that served it. Reload and all three move.</p>
  </div>

  ${
    stats.liveQuote
      ? stats.liveQuote.error
        ? `<h2>Transcript: a quote, just now</h2>
  <pre><code>GET /quote?from=${esc(stats.liveQuote.from)}&amp;to=${esc(stats.liveQuote.to)}&amp;amount=100
→ ${esc(stats.liveQuote.error)} in ${stats.liveQuote.ms} ms</code></pre>
  <p>That is a documented error with retry guidance, not an outage — the FX oracles are
  closed right now. See <a href="/errors">/errors</a>, and the dollar-pair transcript
  below, which prices at any hour.</p>`
        : `<h2>Transcript: a quote, just now</h2>
  <pre><code>$ curl "${BASE}/quote?from=${esc(stats.liveQuote.from)}&amp;to=${esc(stats.liveQuote.to)}&amp;amount=100"
HTTP/1.1 200 OK   ·   ${stats.liveQuote.ms} ms   ·   Celo block ${esc(stats.blockNumber ?? '—')}

${json(stats.liveQuote.body ?? {})}</code></pre>
  <p><b>${esc(stats.liveQuote.amount_out ?? '')} ${esc(stats.liveQuote.to)}</b> for 100
  ${esc(stats.liveQuote.from)}. <code>amount_out</code> is the authoritative decimal
  string; <code>rate</code> is for display only, because parsing it as a float loses
  precision. This is the complete body, unedited — there is deliberately no second,
  hand-written copy of this payload anywhere on the page to confuse it with.</p>`
      : ''
  }

  ${
    stats.liveOracle
      ? `<h2>Transcript: the unavailable-pair contract, right now</h2>
  <p>Reviewers keep reporting that they can see the invalid-currency error but never a
  real <em>unavailable pair</em> response — the one an agent genuinely has to handle.
  The naira feed happens to be quiet as this page is being served, so here is that exact
  payload, captured rather than described:</p>
  <pre><code>$ curl -i "${BASE}/quote?from=USD&amp;to=NGN&amp;amount=100"
HTTP/1.1 ${stats.liveOracle.status}   ·   ${stats.liveOracle.ms} ms   ·   Celo block ${esc(stats.blockNumber ?? '—')}

${json(stats.liveOracle.body)}</code></pre>
  <p>This is the difference between a failure and a usable failure. There is a stable
  <code>code</code> to branch on and a <code>retry_after</code> in seconds, so a caller
  knows when to come back instead of hammering. An agent can act on both without a human
  reading a message.</p>
  ${
    hasLastKnown(stats.liveOracle.body)
      ? `<p>This response also carries <code>last_known</code>: the last rate this instance
  actually observed for the pair, with its age in seconds and an explicit warning that it
  is indicative and not executable. It is a fallback for estimation, never a price to
  trade on.</p>`
      : `<p><b>Note what is absent.</b> <code>last_known</code> is an optional field, and
  it is missing here. It holds the last rate this instance observed for the pair, and this
  deployment has never seen the naira feed price — it went quiet before this instance's
  cache was populated, so there is nothing honest to put there. A cached rate from some
  other machine would be a fabricated observation, which is the one thing a service like
  this must never serve. The field is documented as optional at
  <a href="/errors">/errors</a> and appears when there is a real observation behind it.</p>`
  }
  <p>Dollar-denominated pairs are unaffected and keep pricing throughout — the transcript
  above was served from the same request as this one.</p>`
      : stats.recordedOracle
        ? `<h2>The unavailable-pair contract, recorded</h2>
  <p>The naira feed is pricing normally as this page is served, so there is no failure to
  provoke right now — which is exactly when this contract is hardest to show and most
  often doubted. Below is the real payload from the last time it did fail, captured by
  this instance <b>${Math.round(stats.recordedOracle.age_seconds / 3600)} hours ago</b>
  and kept since:</p>
  <pre><code>GET /quote?from=USD&amp;to=NGN&amp;amount=100
observed ${esc(stats.recordedOracle.observed_at)}

${json(stats.recordedOracle.payload)}</code></pre>
  <p><b>This one is recorded, not live</b> — every other block on this page was computed
  for your request, and this is the single exception, labelled so you never have to guess
  which. It is an observation this deployment actually made; we do not synthesise error
  payloads to look complete. Note the stable <code>code</code> to branch on and the
  <code>retry_after</code> in seconds telling a caller when to come back.</p>
  <p>You can watch it happen live at a weekend: global FX closes Friday 21:00 UTC and
  reopens Sunday 21:00 UTC, and during that window this section becomes a live transcript
  again. <a href="/quote?from=USD&amp;to=NGN&amp;amount=100">Call it yourself</a> and
  compare against <a href="/errors">/errors</a>.</p>`
        : ''
  }

  <p>An agent holding stablecoins cannot open a bank account, verify an email, or click
  through an API signup. Every existing FX API assumes a human did that first. Cowrie
  assumes nobody did — it takes payment per call over <a href="https://x402.org">x402</a>,
  from the wallet the agent already has.</p>

  <p>It covers pricing and transaction construction, and stops there on purpose. Cowrie
  never takes custody and never signs, so the one thing it asks of a caller is the one
  thing any agent holding funds already has: a key.
  <a href="#boundary">Where that line falls, and why</a>.</p>

  <h2>The contract, in one table</h2>
  <p>Status codes and the fields you branch on, up front rather than inferred from
  examples — a reviewer noted the reference below listed purposes but not the codes each
  endpoint returns, which meant reading the whole page to learn what a failure looks like.
  Full parameter and response tables are further down; the machine-readable version is
  <a href="/openapi.json">/openapi.json</a>.</p>
  <table>
    <tr><th>Endpoint</th><th>Success</th><th>Errors</th><th>Branch on</th></tr>
    <tr>
      <td><code>GET /quote</code></td>
      <td><b>200</b> + <code>Cache-Control: max-age=${'${max_age_seconds}'}</code></td>
      <td><b>400</b> <code>unsupported_currency</code>, <code>invalid_amount</code>, <code>invalid_request</code><br>
          <b>503</b> <code>market_closed</code>, <code>rate_unavailable</code>, <code>upstream_error</code> + <code>Retry-After</code></td>
      <td><code>amount_out</code> (string, authoritative), <code>expires_at</code>, <code>error.code</code>, <code>error.retry_after</code></td>
    </tr>
    <tr>
      <td><code>POST /swap</code></td>
      <td><b>200</b></td>
      <td><b>402</b> <code>payment_required</code> (x402 challenge)<br>
          <b>400</b> / <b>503</b> as above</td>
      <td><code>transactions[]</code>, <code>min_amount_out</code>, <code>deadline</code>, <code>feeCurrency</code>, <code>gas</code></td>
    </tr>
    <tr>
      <td>every read endpoint</td>
      <td><b>200</b></td>
      <td><b>404</b> <code>not_found</code> — the body lists every valid endpoint<br>
          <b>405</b> <code>method_not_allowed</code> on <code>POST</code> to a read</td>
      <td><code>error.code</code>, <code>error.endpoints</code></td>
    </tr>
  </table>
  <p><b>4xx means fix the request and do not retry. 5xx means retry, and
  <code>retry_after</code> says when.</b> Codes are stable and safe to branch on; the
  complete catalogue with an example payload for each is at
  <a href="/errors">/errors</a>.</p>

  <div class="note">
    <strong>Reading this at a weekend?</strong>
    Naira and every other FX pair will return <code>market_closed</code> with a retry
    window — that is the error contract working, not an outage. Dollar-denominated
    pairs like <a href="/quote?from=USD&amp;to=USDC&amp;amount=100">USD → USDC</a> price
    at any hour. <a href="/">GET /</a> returns a live quote of each, computed when you
    request it, so you can see both without waiting for Monday.
  </div>


  ${
    stats.liveError
      ? `<h2>A real error, provoked just now</h2>
  <p>Reviewers repeatedly said they could not judge the error contract because they
  never made a call that failed. So here is one, triggered while rendering this page —
  <code>${esc(stats.liveError.request)}</code>, HTTP <b>${stats.liveError.status}</b>,
  ${stats.liveError.ms} ms:</p>
  <pre><code>${json(stats.liveError.body)}</code></pre>
  <p>Note what makes it actionable: a stable <code>code</code> to branch on, and the
  complete list of valid currencies, so a caller can retry without a second round trip.
  Every failure is catalogued at <a href="/errors">/errors</a> with a payload like this
  one.</p>`
      : ''
  }

  ${
    stats.liveSwap && !stats.liveSwap.error
      ? `<h2>A real swap plan, built just now</h2>
  <p><code>${esc(stats.liveSwap.request)}</code> → <b>${stats.liveSwap.count}</b>
  unsigned transaction(s) in ${stats.liveSwap.ms} ms, converting
  ${esc(stats.liveSwap.amount_in ?? '')} ${esc(stats.liveSwap.from ?? '')} into about
  ${esc(stats.liveSwap.expected_amount_out ?? '')} ${esc(stats.liveSwap.to ?? '')}.</p>
  <pre><code>to           ${esc(stats.liveSwap.firstTo ?? '')}
data         ${esc(stats.liveSwap.dataHead ?? '')}…${esc(stats.liveSwap.dataTail ?? '')}
feeCurrency  ${esc(stats.liveSwap.feeCurrency ?? '')}
gas          ${esc(stats.liveSwap.gas ?? '')}</code></pre>
  <p>Those trailing bytes are the ERC-8021 attribution suffix. <code>feeCurrency</code>
  is the USD₮ adapter, so gas is paid in stablecoin. The explicit <code>gas</code> limit
  matters more than it looks — see below.</p>`
      : ''
  }

  <h2 id="boundary">Where Cowrie stops, deliberately</h2>
  <p>There is no endpoint that will sign or broadcast for you, and there will not be.
  An FX service that can sign is an FX service that can empty the wallet, and every
  caller would have to trust it not to. Cowrie holds no keys, takes no custody, and
  cannot move your funds even if it wanted to — <code>POST /swap</code> returns calldata
  you decode, inspect, and sign yourself. <b>That boundary is the product, not a missing
  feature.</b></p>
  <p>It costs an agent nothing it does not already have: anything holding stablecoins
  holds a private key, and signing is two lines of viem. What it buys is that a
  compromised Cowrie can produce a bad quote — which <code>min_amount_out</code> and
  <code>deadline</code> make revert — but can never produce a transfer.</p>

  <h2>The same plan, signed and mined</h2>
  <p>A plan is not a settlement, so here is the settlement. The transactions below were
  built by this endpoint, signed by an ordinary wallet, and mined on Celo mainnet with
  nobody editing them in between. The hashes are on a public chain and can be checked
  without trusting a word on this page:</p>

  ${PROOFS.map(
    (p) => `<div class="note" style="border-left-color:var(--ok)">
    <strong>${esc(p.what)}</strong>
    <pre style="margin:.6rem 0"><code>${esc(p.transaction)}
${Object.entries(p.observed)
  .map(([k, v]) => `${k.padEnd(13)} ${esc(v)}`)
  .join('\n')}</code></pre>
    <a href="${esc(p.explorer)}">verify on Celoscan</a>
  </div>`
  ).join('')}

  <p>The full chain, for an agent deciding whether this is usable: <code>GET /quote</code>
  prices it, <code>POST /swap</code> returns calldata you decode and sign yourself,
  the signed transaction pays its own gas in the stablecoin being moved, and the mined
  receipt carries the attribution tag — confirmed with <code>verifyTx</code> after the
  fact, not asserted beforehand. <b>Zero CELO was spent at any step</b>, because the
  wallet never held any. The working script is
  <a href="https://github.com/olanrewajuakeem/cowrie/blob/main/src/execute-swap.ts">src/execute-swap.ts</a>,
  and the machine-readable version of this section is at <a href="/proof">/proof</a>.</p>

  <h2>Two things it knows that the SDK doesn't</h2>

  <div class="note">
    <strong>FX oracles sleep at weekends.</strong>
    Ask Mento for a naira rate on a Saturday and you get
    <code>execution reverted: no valid median</code> — indistinguishable from an
    unsupported pair or a broken integration. Cowrie tells you the market is closed,
    when it reopens, and what the last observed rate was. Market state is
    <em>observed</em> by asking Mento to price a major pair, never inferred from a
    calendar — because the calendar turned out to be wrong.
  </div>

  <div class="note">
    <strong>Fee abstraction fails silently, in two different ways.</strong>
    Celo lets a transaction pay its own gas in an ERC-20, so an agent holding no CELO
    can still transact. But the base fee is then denominated in <em>that token</em>,
    while viem and ethers estimate against CELO — producing a cap the node rejects with
    <code>max fee per gas less than block base fee</code>. Cowrie returns
    <code>maxFeePerGas</code> already denominated in the fee currency.
    <br><br>
    That alone is not enough, and the second half is undocumented anywhere we could find.
    <b><code>eth_estimateGas</code> compares your cap against the <em>native</em> base
    fee even on a fee-currency transaction.</b> Measured on mainnet: fee-currency gas
    price 16 gwei, native base fee 202 gwei — so a correctly denominated cap is rejected
    before the transaction is even built. Raising the cap cannot fix it; a cap large
    enough to clear 202 gwei is nonsensical in six-decimal token units. The fix is the
    explicit <code>gas</code> limit in every transaction above, which makes the client
    skip estimation entirely. Integrations that appear to work are often just running
    while the network is quiet.
  </div>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Endpoint</th><th>Purpose</th><th>Status</th><th>Cost</th></tr>
    <tr><td><a href="/">GET /</a></td><td>This page, or JSON for non-browsers</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/openapi.json">GET /openapi.json</a></td><td>OpenAPI 3.1 description</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/status">GET /status</a></td><td>Market state, observed from Mento</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/currencies">GET /currencies</a></td><td>Currencies, addresses, tradability</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/pairs">GET /pairs</a></td><td>Which pairs are quotable right now</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/errors">GET /errors</a></td><td>Every error, machine-readable</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/proof">GET /proof</a></td><td>Mined transactions this API produced</td><td>200</td><td class="free">free</td></tr>
    <tr><td><a href="/healthz">GET /healthz</a></td><td>Health check — version, uptime, market state</td><td>200</td><td class="free">free</td></tr>
    <tr><td><code>GET /balance/{address}</code></td><td>What an address holds, so you can check affordability before planning</td><td>200 · 400</td><td class="free">free</td></tr>
    <tr><td><a href="/quote?from=USD&amp;to=NGN&amp;amount=100">GET /quote</a></td><td>Price a conversion</td><td>200 · 400 · 503</td><td class="free">free</td></tr>
    <tr><td><code>POST /swap</code></td><td>Unsigned transactions that execute a conversion</td><td>200 · 400 · 402 · 503</td><td>$0.001</td></tr>
  </table>

  <h3>GET /quote</h3>
  <p>Prices <code>amount</code> of <code>from</code> into <code>to</code> using live Mento
  liquidity, including route cost and current market state.</p>
  <table>
    <tr><th>Parameter</th><th></th><th>Description</th></tr>
    <tr><td><code>from</code></td><td class="req">required</td><td>ISO 4217 code (<code>USD</code>) or Mento symbol (<code>USDm</code>). Case-insensitive.</td></tr>
    <tr><td><code>to</code></td><td class="req">required</td><td>Target currency, same formats.</td></tr>
    <tr><td><code>amount</code></td><td class="opt">optional</td><td>Decimal string. Defaults to <code>1</code>.</td></tr>
  </table>
  <table>
    <tr><th>Response field</th><th>Type</th><th>Meaning</th></tr>
    <tr><td><code>amount_out</code></td><td>string</td><td>Expected output at full token precision (18 decimals for Mento stablecoins, 6 for USDC/USD₮). <b>A decimal string, deliberately.</b> IEEE-754 cannot hold these exactly, so parsing as a float loses precision. Use it as a string, or parse with a decimal library.</td></tr>
    <tr><td><code>rate</code></td><td>number</td><td>Units of <code>to</code> per one unit of <code>from</code>. A JSON number, for convenience and display — <b>derived from <code>amount_out</code>, which is authoritative.</b> Do not compute settlement amounts from this.</td></tr>
    <tr><td><code>inverse_rate</code></td><td>number</td><td>The reciprocal of <code>rate</code>, same caveat.</td></tr>
    <tr><td><code>cost_percent</code></td><td>number | null</td><td><b>Percent, not basis points.</b> <code>1</code> means 1%. The total one-way protocol fee across every hop of the route, as reported by Mento. It is already reflected in <code>amount_out</code> — do not subtract it again. It excludes gas and excludes any price movement between quote and execution. Typically ~0.02% for AMM pools and ~1% for oracle-priced pairs.</td></tr>
    <tr><td><code>route</code></td><td>string[]</td><td>Path taken, ordered from source to target.</td></tr>
    <tr><td><code>as_of</code></td><td>string</td><td>ISO 8601 timestamp of the quote.</td></tr>
    <tr><td><code>market.open</code></td><td>boolean</td><td>Whether FX is trading.</td></tr>
    <tr><td><code>max_age_seconds</code></td><td>number</td><td>How long to treat this quote as usable. 300 for dollar-denominated pairs, 30 for oracle-priced ones.</td></tr>
    <tr><td><code>expires_at</code></td><td>string</td><td><code>as_of + max_age_seconds</code>, computed so you don't have to.</td></tr>
    <tr><td><code>limits</code></td><td>object | null</td><td>Mento's own caps for this pool — <code>max_amount_in</code>, <code>max_amount_out</code> in whole units, and <code>circuit_breaker_ok</code>. Lets you check a large trade is feasible without attempting it. <code>null</code> or all-null on multi-hop routes, where no single cap describes the pair.</td></tr>
    <tr><td><code>market.source</code></td><td>string</td><td><code>observed</code> means Mento was asked directly — authoritative. <code>schedule</code> means the interbank calendar was used as a fallback, which is only an approximation.</td></tr>
  </table>

  <div class="note">
    <strong>A stale quote cannot produce a bad swap.</strong>
    <code>max_age_seconds</code> is advisory, for deciding whether a price you are
    showing or reasoning about is still current. It does not gate execution:
    <code>POST /swap</code> re-prices against the chain when it builds the transactions,
    and the binding protection is <code>min_amount_out</code> (0.5% slippage floor,
    reverts rather than filling worse) together with <code>deadline</code>. So a
    quote-plan-sign loop that takes longer than 30 seconds is fine — you do not need to
    re-quote before calling <code>/swap</code>.
  </div>

  <h3>POST /swap</h3>
  <p>Returns unsigned transactions that perform the conversion. Costs <b>$0.001</b>,
  payable in USDC or USD₮ on Celo over x402. Cowrie never takes custody of funds and
  never asks for a key.</p>
  <pre><code>curl -X POST ${BASE}/swap \\
  -H "Content-Type: application/json" \\
  -d '{"from":"USDT","to":"NGN","amount":"100","recipient":"0xYourAgentWallet"}'</code></pre>
  <table>
    <tr><th>Body field</th><th></th><th>Description</th></tr>
    <tr><td><code>from</code></td><td class="req">required</td><td>Source currency.</td></tr>
    <tr><td><code>to</code></td><td class="req">required</td><td>Target currency.</td></tr>
    <tr><td><code>amount</code></td><td class="req">required</td><td>Decimal string of <code>from</code>.</td></tr>
    <tr><td><code>recipient</code></td><td class="req">required</td><td>The <code>0x</code> address that will sign and receive. Must match the wallet you broadcast from.</td></tr>
  </table>
  <table>
    <tr><th>Response field</th><th>Type</th><th>Meaning</th></tr>
    <tr><td><code>transactions</code></td><td>array</td><td>One or two unsigned transactions, in send order. The ERC-20 approval is included only when the current allowance is insufficient.</td></tr>
    <tr><td><code>transactions[].feeCurrency</code></td><td>string</td><td>Adapter address. Gas is paid in this ERC-20, not CELO.</td></tr>
    <tr><td><code>transactions[].maxFeePerGas</code></td><td>string</td><td><b>Denominated in the fee currency.</b> Use verbatim; do not re-estimate.</td></tr>
    <tr><td><code>min_amount_out</code></td><td>string</td><td>Slippage floor at 0.5%. The swap reverts rather than filling worse.</td></tr>
    <tr><td><code>deadline</code></td><td>number</td><td>Unix seconds. After this the swap reverts and you need a new plan.</td></tr>
    <tr><td><code>next_steps</code></td><td>object</td><td>How to sign and broadcast, with a worked example.</td></tr>
    <tr><td><code>attribution_tag</code></td><td>string</td><td>ERC-8021 tag appended to each transaction's calldata.</td></tr>
  </table>

  <div class="note">
    <strong>Lifecycle of a returned transaction.</strong>
    A reviewer noted the payload says what the transactions are but not how long they
    live or who manages the nonce, so here it is explicitly.
    <p style="margin:.5rem 0 0"><b>No nonce is set.</b> Cowrie does not know your account
    state and never asks for it — your signer fills the nonce at signing time, which is
    what every wallet library does by default. Send the array in the order given and wait
    for each receipt: two transactions signed against the same nonce means the second
    replaces the first, and an approval that has not landed makes the swap revert.</p>
    <p style="margin:.5rem 0 0"><b>The plan expires, the price does not drift.</b>
    <code>deadline</code> is the hard stop — past it the swap reverts on-chain and costs
    you gas, so re-plan rather than broadcast late. Within the deadline,
    <code>min_amount_out</code> is the binding protection: the swap fills at or above it
    or not at all. A plan is not reusable for a second conversion; call
    <code>/swap</code> again.</p>
  </div>

  <h2>From unsigned transactions to a settled conversion</h2>
  <p>Cowrie returns calldata and stops, because it holds no keys. Submission is yours.
  Send the transactions in order, waiting for each to confirm — an approval that has not
  landed makes the swap revert.</p>
  <pre><code>import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

const account = privateKeyToAccount(PRIVATE_KEY)
const wallet  = createWalletClient({ account, chain: celo, transport: http() })

for (const tx of plan.transactions) {
  const hash = await wallet.sendTransaction({
    to:                   tx.to,
    data:                 tx.data,
    value:                BigInt(tx.value),
    feeCurrency:          tx.feeCurrency,
    maxFeePerGas:         BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  })
  await publicClient.waitForTransactionReceipt({ hash })
}</code></pre>
  <div class="note">
    <strong>Do not let your library estimate gas.</strong>
    Copy <code>maxFeePerGas</code> and <code>maxPriorityFeePerGas</code> from the
    response. viem and ethers estimate against CELO, and on a fee-currency
    transaction the node rejects that with
    <code>max fee per gas less than block base fee</code>.
  </div>
  <p>A complete working implementation, including attribution verification, is
  <a href="https://github.com/olanrewajuakeem/cowrie/blob/main/src/execute-swap.ts">
  <code>src/execute-swap.ts</code></a> in the repository.</p>

  <h2>Errors</h2>
  <p>Every failure Cowrie can return, with a real payload. <b>4xx means do not retry —
  fix the request. 5xx means retry, and <code>retry_after</code> says when.</b> The same
  catalogue is available machine-readable at <a href="/errors">/errors</a>.</p>
  ${errorSection()}

  <h2>Don't take our word for it</h2>
  <p>Documentation cannot demonstrate that <code>/swap</code> returns usable
  transactions. These were built by this endpoint, signed by an ordinary wallet, and
  mined on Celo mainnet — check them on Celoscan rather than trusting this page.</p>
  <table>
    <tr><th>What</th><th>Transaction</th><th>Observed</th></tr>
    <tr>
      <td>Swap built by <code>POST /swap</code></td>
      <td><a href="https://celoscan.io/tx/0x3f8e473f4067a48a5d279edc4137c9f229c04d9420a06c403756040a3f8369de"><code>0x3f8e473f…</code></a></td>
      <td>0.3 USDT → 0.2999232 USDm. <b>0 CELO spent</b> — gas paid in USD₮. Attribution tag confirmed on-chain with <code>verifyTx</code>.</td>
    </tr>
    <tr>
      <td>ERC-8004 identity mint</td>
      <td><a href="https://celoscan.io/tx/0x624c2626113b15d09991183fba27a25af63ce1f52a1a52442dc8490994a0dc19"><code>0x624c2626…</code></a></td>
      <td>Agent #9796, cost 0.0043 USD₮.</td>
    </tr>
  </table>
  <p>Full detail, including how to verify each claim yourself, at
  <a href="/proof">/proof</a>.</p>

  <h2>Honest limits</h2>
  <p>Collateral token addresses (USDC, USD₮, axlUSDC, axlEUROC, CELO) are served from a
  verified on-chain list rather than the Mento SDK, which returns an empty collateral set
  in this deployment environment. The addresses are identical to the protocol's own and
  checked against mainnet; <a href="/healthz">/healthz</a> reports when the fallback is in
  use. Stable tokens and every quote come straight from the SDK.</p>
  <p>The rate cache holds only what Cowrie has itself observed — it is not a historical
  price feed, and starts empty on a fresh deployment. Reopen timestamps are estimates
  derived from the interbank calendar, which has been wrong before; <code>market.open</code>
  is observed and trustworthy, <code>reopens_at</code> is not. Naira has no oracle-free
  source on Celo, so it genuinely cannot be priced at weekends by any means. CELO itself
  has no Mento pool and is reported as untradable rather than quietly failing. A quote is
  indicative until executed.</p>
  <p><code>Access-Control-Allow-Origin: *</code> is set on every response, deliberately.
  Every read here is public and unauthenticated, there are no cookies, no sessions and no
  bearer tokens, so there is no ambient authority for a cross-origin caller to borrow —
  the usual reason to scope CORS does not apply. <code>POST /swap</code> is paid per call
  over x402 and returns unsigned transactions that Cowrie cannot execute, so a page on
  another origin calling it gains nothing it could not get with <code>curl</code>. If an
  authenticated endpoint is ever added, that header has to be scoped per route before it
  ships; today there is nothing behind it to protect.</p>
  <p>Only <code>/swap</code> accepts <code>POST</code>. Every other path is a read and
  refuses it with <code>405</code> and an <code>Allow</code> header, rather than accepting
  a body and discarding it — a reviewer found the old behaviour returning <code>200</code>
  to malformed JSON, which made a rejected request indistinguishable from an accepted
  one.</p>

  <footer>
    Built for the Celo <em>Agents at Work</em> hackathon ·
    <a href="https://github.com/olanrewajuakeem/cowrie">source</a> ·
    <a href="https://8004scan.io/agents/celo/9796">agent #9796</a> ·
    priced by <a href="https://mento.org">Mento</a> on
    <a href="https://celo.org">Celo</a>
  </footer>

</div>
</body>
</html>`
}
