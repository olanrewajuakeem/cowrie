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
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
  <p class="lede">Foreign exchange for autonomous agents, on Celo.</p>

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
    request, not written by hand.${
      stats.degraded
        ? ` <b style="color:var(--warn)">Degraded:</b> ${esc(stats.degraded)}`
        : ''
    }
  </p>

  <p>An agent holding stablecoins cannot open a bank account, verify an email, or click
  through an API signup. Every existing FX API assumes a human did that first. Cowrie
  assumes nobody did — it takes payment per call over <a href="https://x402.org">x402</a>,
  from the wallet the agent already has.</p>

  <pre><code>curl "${BASE}/quote?from=USD&amp;to=NGN&amp;amount=100"</code></pre>
  <pre><code>{
  "from": "USD", "to": "NGN",
  "amount_in": "100",
  "amount_out": "131517.768183327798073729",
  "rate": 1315.177681833278,
  "inverse_rate": 0.0007603535353535353,
  "cost_percent": 1,
  "route": ["USD", "NGN"],
  "as_of": "2026-09-03T07:36:12.309Z",
  "market": { "open": true, "source": "observed", "closes_at": "2026-09-04T21:00:00.000Z" }
}</code></pre>

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
    <strong>Fee abstraction fails silently without the right gas price.</strong>
    Celo lets a transaction pay its own gas in an ERC-20, so an agent holding no CELO
    can still transact. But the base fee is then denominated in <em>that token</em>,
    while viem and ethers estimate against CELO — producing a cap the node rejects with
    <code>max fee per gas less than block base fee</code>. Cowrie returns
    <code>maxFeePerGas</code> already denominated in the fee currency.
  </div>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Endpoint</th><th>Purpose</th><th>Cost</th></tr>
    <tr><td><a href="/">GET /</a></td><td>This page, or JSON for non-browsers</td><td class="free">free</td></tr>
    <tr><td><a href="/openapi.json">GET /openapi.json</a></td><td>OpenAPI 3.1 description</td><td class="free">free</td></tr>
    <tr><td><a href="/status">GET /status</a></td><td>Market state, observed from Mento</td><td class="free">free</td></tr>
    <tr><td><a href="/currencies">GET /currencies</a></td><td>Currencies, addresses, tradability</td><td class="free">free</td></tr>
    <tr><td><a href="/pairs">GET /pairs</a></td><td>Which pairs are quotable right now</td><td class="free">free</td></tr>
    <tr><td><a href="/errors">GET /errors</a></td><td>Every error, machine-readable</td><td class="free">free</td></tr>
    <tr><td><a href="/proof">GET /proof</a></td><td>Mined transactions this API produced</td><td class="free">free</td></tr>
    <tr><td><a href="/quote?from=USD&amp;to=NGN&amp;amount=100">GET /quote</a></td><td>Price a conversion</td><td class="free">free</td></tr>
    <tr><td><code>POST /swap</code></td><td>Unsigned transactions that execute a conversion</td><td>$0.001</td></tr>
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
    <tr><td><code>market.source</code></td><td>string</td><td><code>observed</code> means Mento was asked directly — authoritative. <code>schedule</code> means the interbank calendar was used as a fallback, which is only an approximation.</td></tr>
  </table>

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
  <p>The rate cache holds only what Cowrie has itself observed — it is not a historical
  price feed, and starts empty on a fresh deployment. Reopen timestamps are estimates
  derived from the interbank calendar, which has been wrong before; <code>market.open</code>
  is observed and trustworthy, <code>reopens_at</code> is not. Naira has no oracle-free
  source on Celo, so it genuinely cannot be priced at weekends by any means. CELO itself
  has no Mento pool and is reported as untradable rather than quietly failing. A quote is
  indicative until executed.</p>

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
