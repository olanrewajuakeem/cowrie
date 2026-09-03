/**
 * Evidence that this API's output actually works on-chain.
 *
 * A reviewer put it precisely: "The API lacks runtime validation:
 * documentation alone doesn't prove that /quote returns valid rates or that
 * /swap produces usable transactions." Another concluded an agent "can safely
 * use it for read-only rate queries but should treat swap execution as
 * unverified."
 *
 * That was fair. The transactions below were built by this service's own
 * /swap endpoint, signed by an ordinary wallet, and mined on Celo mainnet.
 * Anyone can verify them on Celoscan without trusting anything written here.
 *
 * These are recorded facts, not a live health check — see `verify_yourself`
 * for how to reproduce the claim rather than take it on faith.
 */
export interface ProofEntry {
  what: string
  transaction: string
  explorer: string
  observed: Record<string, string>
}

export const PROOFS: ProofEntry[] = [
  {
    what: 'ERC-20 approval built by POST /swap, signed and broadcast unmodified.',
    transaction: '0x8666f1756e50a48f5523f1d21f20d336ce3ddfcc0fba1919a16a9d710a84aff9',
    explorer:
      'https://celoscan.io/tx/0x8666f1756e50a48f5523f1d21f20d336ce3ddfcc0fba1919a16a9d710a84aff9',
    observed: {
      status: 'success',
      gas_used: '112553',
      gas_paid_in: 'USD₮ — not CELO',
      attribution: 'celo_e46217d1e056, confirmed with verifyTx against the mined transaction',
    },
  },
  {
    what: 'The swap itself: 0.3 USDT into USDm, built by POST /swap and broadcast unmodified.',
    transaction: '0x3f8e473f4067a48a5d279edc4137c9f229c04d9420a06c403756040a3f8369de',
    explorer:
      'https://celoscan.io/tx/0x3f8e473f4067a48a5d279edc4137c9f229c04d9420a06c403756040a3f8369de',
    observed: {
      status: 'success',
      gas_used: '383384',
      celo_spent: '0 — the wallet held none, gas came out of USD₮ via fee abstraction',
      received: '0.2999232273552 USDm, against a quoted 0.299921448711',
      attribution: 'celo_e46217d1e056, confirmed with verifyTx',
    },
  },
  {
    what: 'ERC-8004 agent identity minted for this service, gas paid in USD₮.',
    transaction: '0x624c2626113b15d09991183fba27a25af63ce1f52a1a52442dc8490994a0dc19',
    explorer:
      'https://celoscan.io/tx/0x624c2626113b15d09991183fba27a25af63ce1f52a1a52442dc8490994a0dc19',
    observed: {
      agent_id: '9796',
      registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      cost: '0.0043 USD₮ (~$0.0003)',
    },
  },
]

export function proof() {
  return {
    note: 'Transactions produced by this API and mined on Celo mainnet. Provided because documentation alone cannot demonstrate that /swap returns usable transactions — these can be checked on Celoscan without trusting this service.',
    agent: {
      erc8004_id: 9796,
      identity: 'https://8004scan.io/agents/celo/9796',
      attribution_tag: 'celo_e46217d1e056',
    },
    proofs: PROOFS,
    verify_yourself: {
      quotes:
        'GET /quote returns as_of and max_age_seconds. Compare rate against amount_out / amount_in — they are derived from the same on-chain call, and amount_out is authoritative.',
      transactions:
        'POST /swap returns calldata you can decode yourself before signing. The ERC-8021 attribution suffix is the trailing bytes; decode it with fromDataSuffix from @celo/attribution-tags.',
      attribution:
        'After broadcasting, run verifyTx from @celo/attribution-tags against the mined transaction and confirm the codes include the tag above.',
      reference_implementation:
        'https://github.com/olanrewajuakeem/cowrie/blob/main/src/execute-swap.ts',
    },
    honest_caveat:
      'These are recorded transactions, not a continuous health check. They demonstrate the endpoint produced valid, executable transactions at the time they were made. Cowrie holds no keys and cannot broadcast on your behalf, so the signing and submission half is always yours.',
  }
}
