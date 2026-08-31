/**
 * HTML served at / when the caller is a browser.
 *
 * Agents get JSON; people get this. Self-contained with no external assets —
 * nothing to fail, nothing to load, and it renders identically offline.
 */
const BASE = process.env.PUBLIC_URL ?? 'https://cowrie-seven.vercel.app'

export function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cowrie — FX for agents on Celo</title>
<meta name="description" content="Foreign exchange rates and swap execution for autonomous agents, priced on Celo via Mento. No signup, pay per call over x402.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf7; --fg: #1a1a1a; --dim: #6b6b6b; --line: #e5e2dc;
    --card: #ffffff; --accent: #8b5e34; --code-bg: #f4f2ee;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131211; --fg: #ececec; --dim: #9a9590; --line: #2c2a27;
      --card: #1a1917; --accent: #d4a373; --code-bg: #201e1c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 2.5rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1.15rem; margin: 2.75rem 0 .75rem; letter-spacing: -.01em; }
  .tag { color: var(--accent); font-weight: 600; }
  .lede { font-size: 1.15rem; color: var(--dim); margin: 0 0 1.5rem; }
  p { margin: 0 0 1rem; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
  a:hover { border-bottom-color: currentColor; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .875rem; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
  pre {
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 1rem; overflow-x: auto; margin: 0 0 1rem;
  }
  pre code { background: none; padding: 0; }
  .facts { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 2rem; }
  .fact {
    border: 1px solid var(--line); background: var(--card);
    border-radius: 999px; padding: .3rem .75rem; font-size: .82rem; color: var(--dim);
  }
  .fact b { color: var(--fg); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 1rem; font-size: .9rem; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--dim); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  td:first-child { white-space: nowrap; }
  .note {
    border-left: 3px solid var(--accent); background: var(--card);
    padding: .9rem 1rem; border-radius: 0 8px 8px 0; margin: 0 0 1rem;
  }
  .note strong { display: block; margin-bottom: .25rem; }
  footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); color: var(--dim); font-size: .875rem; }
  .free { color: var(--dim); font-size: .8rem; }
</style>
</head>
<body>
<div class="wrap">

  <h1>Cowrie</h1>
  <p class="lede">Foreign exchange for autonomous agents, on Celo.</p>

  <div class="facts">
    <span class="fact"><b>19</b> tradable currencies</span>
    <span class="fact"><b>342</b> routed pairs</span>
    <span class="fact">ERC-8004 <b>#9796</b></span>
    <span class="fact"><b>$0.001</b> per swap, x402</span>
    <span class="fact"><b>0</b> CELO needed</span>
  </div>

  <p>An agent holding stablecoins cannot open a bank account, verify an email, or click
  through an API signup. Every existing FX API assumes a human did that first. Cowrie
  assumes nobody did — it takes payment per call over
  <a href="https://x402.org">x402</a>, from the wallet the agent already has.</p>

  <h2>Ask it something</h2>
  <pre><code>curl "${BASE}/quote?from=USD&amp;to=NGN&amp;amount=100"</code></pre>
  <pre><code>{
  "from": "USD", "to": "NGN",
  "amount_out": "133277.688776403117890173",
  "rate": 1332.776887764031,
  "cost_percent": 1,
  "route": ["USD", "NGN"],
  "market": { "open": true, "source": "observed" }
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
    <tr><th>Endpoint</th><th>Does</th></tr>
    <tr><td><a href="/">GET /</a></td><td>This page, or JSON for non-browsers <span class="free">· free</span></td></tr>
    <tr><td><a href="/openapi.json">GET /openapi.json</a></td><td>OpenAPI 3.1 description <span class="free">· free</span></td></tr>
    <tr><td><a href="/status">GET /status</a></td><td>Market state, observed from Mento <span class="free">· free</span></td></tr>
    <tr><td><a href="/currencies">GET /currencies</a></td><td>Currencies, addresses, tradability <span class="free">· free</span></td></tr>
    <tr><td><a href="/pairs">GET /pairs</a></td><td>Which pairs work right now <span class="free">· free</span></td></tr>
    <tr><td><a href="/quote?from=USD&amp;to=NGN&amp;amount=100">GET /quote</a></td><td>Price a conversion <span class="free">· free</span></td></tr>
    <tr><td><code>POST /swap</code></td><td>Unsigned transactions, gas payable in stablecoin <span class="free">· $0.001</span></td></tr>
  </table>

  <h2>Executing a swap</h2>
  <pre><code>curl -X POST ${BASE}/swap \\
  -H "Content-Type: application/json" \\
  -d '{"from":"USDT","to":"NGN","amount":"100","recipient":"0xYourAgent"}'</code></pre>
  <p>Returns an ERC-20 approval (only when the allowance is short) and the swap, both
  unsigned. Cowrie never takes custody and never asks for a key. Every transaction
  carries the ERC-8021 attribution tag <code>celo_e46217d1e056</code>.</p>

  <h2>Honest limits</h2>
  <p>The rate cache holds only what Cowrie has itself observed — it is not a historical
  price feed. Reopen timestamps are estimates. Naira has no oracle-free source on Celo,
  so it genuinely cannot be priced at weekends by any means. CELO itself has no Mento
  pool and is reported as untradable rather than quietly failing.</p>

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
