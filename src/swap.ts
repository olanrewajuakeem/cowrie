/**
 * Swap builder.
 *
 * Returns unsigned transactions an agent can sign and broadcast itself. Cowrie
 * never holds funds, never takes custody, and never asks for a private key —
 * it assembles the calldata and hands it back.
 *
 * Three things here that an agent cannot easily work out on its own, and which
 * are the actual reason this endpoint is worth paying for:
 *
 *   1. The ERC-20 approval. Mento's router must be allowed to move the input
 *      token before any swap can succeed. An agent that sends only the swap
 *      gets an on-chain revert that is miserable to diagnose. We check the
 *      current allowance and include the approval only when it is needed.
 *
 *   2. feeCurrency. An agent holding only stablecoins has no CELO and normally
 *      cannot transact at all. Celo's fee abstraction lets a transaction pay
 *      its own gas in an ERC-20, but the field must be set and must point at
 *      the adapter, not the token.
 *
 *   3. The attribution tag, appended as an ERC-8021 data suffix.
 */
import { encodeFunctionData, parseAbi, parseUnits, formatUnits } from 'viem'
import { toDataSuffix } from '@celo/attribution-tags'
import { createRequire } from 'node:module'
import { getMento, loadCurrencies, resolve } from './tokens.js'
import { isMarketOpen } from './market.js'
import { classifyError, type FxError } from './fx.js'

const require = createRequire(import.meta.url)
const { deadlineFromMinutes } = require('@mento-protocol/mento-sdk')

/** USD₮ fee-currency ADAPTER — not the token. Celo prices gas in 18 decimals
 *  and USD₮ has 6, so it is allowlisted through this adapter. */
export const USDT_FEE_ADAPTER = '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72'

/** Assigned at hackathon registration, derived from the GitHub repo slug. */
const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? 'celo_e46217d1e056'

const erc20 = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export interface UnsignedTx {
  to: `0x${string}`
  data: `0x${string}`
  value: string
  /** Pay gas in this ERC-20 instead of CELO. Celo-specific. */
  feeCurrency: string
  /**
   * Gas price DENOMINATED IN THE FEE CURRENCY.
   *
   * This is the trap that makes fee abstraction fail in practice. When gas is
   * paid in an ERC-20, Celo expresses the block base fee in that token — but
   * standard tooling (viem, ethers) estimates against CELO and produces a cap
   * the node rejects with "max fee per gas less than block base fee". The
   * correct values come from eth_gasPrice / eth_maxPriorityFeePerGas called
   * WITH the fee-currency address as a parameter, which no library does by
   * default. We do it here so the agent never has to discover this.
   */
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  description: string
}

/** Gas price in a given fee currency, via Celo's currency-aware RPC methods. */
async function feeParams(
  client: any,
  feeCurrency: string
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const [price, tip] = await Promise.all([
    client.request({ method: 'eth_gasPrice', params: [feeCurrency] }),
    client.request({ method: 'eth_maxPriorityFeePerGas', params: [feeCurrency] }),
  ])
  // Double the observed price as headroom: the base fee can rise between our
  // quote and the agent actually broadcasting, and an underpriced transaction
  // is rejected outright rather than merely being slow.
  return {
    maxFeePerGas: BigInt(price) * 2n,
    maxPriorityFeePerGas: BigInt(tip),
  }
}

export interface SwapPlan {
  from: string
  to: string
  amount_in: string
  expected_amount_out: string
  min_amount_out: string
  rate: number
  cost_percent: number | null
  route: string[]
  deadline: number
  recipient: string
  transactions: UnsignedTx[]
  attribution_tag: string
  /**
   * How to get from these unsigned transactions to a settled conversion.
   *
   * Added after a reviewer pointed out that returning calldata and stopping
   * leaves an agent "stuck holding raw transaction data with no ability to
   * sign or submit". Cowrie deliberately never holds keys, so submission is
   * the caller's job — but saying so, and showing how, is ours.
   */
  next_steps: {
    summary: string
    steps: string[]
    example: string
    reference_implementation: string
  }
  notes: string[]
}

/** Worked submission example, returned inline so an agent never has to leave the payload. */
function nextSteps(txCount: number) {
  return {
    summary:
      'These transactions are unsigned. Sign each one with the recipient key and broadcast it yourself — Cowrie never holds keys and cannot submit on your behalf.',
    steps: [
      `Send the ${txCount} transaction(s) in the order given.`,
      'Copy to, data, value, feeCurrency, maxFeePerGas and maxPriorityFeePerGas from each transaction verbatim.',
      'Do NOT let your library estimate gas. When gas is paid in an ERC-20, Celo denominates the base fee in that token; viem and ethers estimate against CELO and produce a cap the node rejects with "max fee per gas less than block base fee". The values above are already denominated correctly.',
      'Wait for each transaction to confirm before sending the next. An approval that has not landed makes the swap revert.',
      `Confirm before the deadline. After it, the swap reverts and you must request a new plan.`,
      'Optionally verify attribution with verifyTx from @celo/attribution-tags against the mined transaction.',
    ],
    example: [
      "import { createWalletClient, http } from 'viem'",
      "import { privateKeyToAccount } from 'viem/accounts'",
      "import { celo } from 'viem/chains'",
      '',
      'const account = privateKeyToAccount(PRIVATE_KEY)',
      'const wallet = createWalletClient({ account, chain: celo, transport: http() })',
      '',
      'for (const tx of plan.transactions) {',
      '  const hash = await wallet.sendTransaction({',
      '    to: tx.to,',
      '    data: tx.data,',
      '    value: BigInt(tx.value),',
      '    feeCurrency: tx.feeCurrency,',
      '    maxFeePerGas: BigInt(tx.maxFeePerGas),',
      '    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),',
      '  })',
      '  await publicClient.waitForTransactionReceipt({ hash })',
      '}',
    ].join('\n'),
    reference_implementation:
      'https://github.com/olanrewajuakeem/cowrie/blob/main/src/execute-swap.ts',
  }
}

export type SwapResult = { ok: true; plan: SwapPlan } | { ok: false; error: FxError }

/**
 * Mento normalises route ids alphabetically ("USDC-USDm"), so the token order
 * it reports does not follow the direction of the trade. Reporting a route as
 * USDC -> USD when the agent asked for USD -> USDC is quietly wrong, and
 * exactly the sort of thing that erodes trust in everything else we return.
 */
function orderRoute(route: string[], from: string, to: string): string[] {
  if (route.length < 2) return [from, to]
  return route[0] === from ? route : [...route].reverse()
}

/** Append an ERC-8021 attribution suffix to existing calldata. */
function tag(data: string): `0x${string}` {
  const suffix = toDataSuffix(ATTRIBUTION_TAG)
  return `${data}${suffix.slice(2)}` as `0x${string}`
}

export async function buildSwap(
  fromInput: string,
  toInput: string,
  amount: string,
  recipient: string,
  rpcUrl?: string
): Promise<SwapResult> {
  const now = new Date()
  const currencies = await loadCurrencies(rpcUrl)
  const from = resolve(currencies, fromInput)
  const to = resolve(currencies, toInput)

  if (!from || !to) {
    return {
      ok: false,
      error: {
        code: 'unsupported_currency',
        message: `Unknown currency "${!from ? fromInput : toInput}".`,
        supported: [...new Set(currencies.values())].map((c) => c.iso).sort(),
      },
    }
  }
  if (from.address === to.address) {
    return {
      ok: false,
      error: { code: 'invalid_amount', message: 'Source and target currency are the same.' },
    }
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return {
      ok: false,
      error: {
        code: 'invalid_request',
        message: `"recipient" must be a 0x address, got "${recipient}".`,
      },
    }
  }

  const numeric = Number(amount)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return {
      ok: false,
      error: { code: 'invalid_amount', message: `Amount must be positive, got "${amount}".` },
    }
  }

  const mento = await getMento(rpcUrl)
  const amountIn = parseUnits(amount, from.decimals)

  try {
    const built: any = await mento.swap.buildSwapParams(
      from.address,
      to.address,
      amountIn,
      recipient as `0x${string}`,
      { slippageTolerance: 0.5, deadline: deadlineFromMinutes(10) }
    )

    const router = built.params.to as `0x${string}`
    const transactions: UnsignedTx[] = []
    const fees = await feeParams(
      (mento as any).client ?? (mento as any).publicClient,
      USDT_FEE_ADAPTER
    )

    // Approval is standard ERC-20, so we read and encode it directly rather
    // than relying on another SDK signature. Only included when actually
    // needed — a redundant approval costs the agent gas for nothing.
    const publicClient = (mento as any).client ?? (mento as any).publicClient
    let allowance = 0n
    try {
      allowance = (await publicClient.readContract({
        address: from.address,
        abi: erc20,
        functionName: 'allowance',
        args: [recipient as `0x${string}`, router],
      })) as bigint
    } catch {
      // If we cannot read it, include the approval rather than risk a revert.
      allowance = 0n
    }

    if (allowance < amountIn) {
      transactions.push({
        to: from.address,
        data: tag(
          encodeFunctionData({ abi: erc20, functionName: 'approve', args: [router, amountIn] })
        ),
        value: '0',
        feeCurrency: USDT_FEE_ADAPTER,
        maxFeePerGas: String(fees.maxFeePerGas),
        maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
        description: `Approve Mento's router to spend ${amount} ${from.iso}. Required before the swap; send this first and wait for it to confirm.`,
      })
    }

    transactions.push({
      to: router,
      data: tag(built.params.data),
      value: String(built.params.value ?? '0'),
      feeCurrency: USDT_FEE_ADAPTER,
      maxFeePerGas: String(fees.maxFeePerGas),
      maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
      description: `Swap ${amount} ${from.iso} for at least ${formatUnits(BigInt(built.amountOutMin), to.decimals)} ${to.iso}.`,
    })

    const expectedOut = formatUnits(BigInt(built.expectedAmountOut), to.decimals)

    return {
      ok: true,
      plan: {
        from: from.iso,
        to: to.iso,
        amount_in: amount,
        expected_amount_out: expectedOut,
        min_amount_out: formatUnits(BigInt(built.amountOutMin), to.decimals),
        rate: Number(expectedOut) / numeric,
        cost_percent: built.route?.costData?.totalCostPercent ?? null,
        route: orderRoute(
          (built.route?.tokens ?? []).map((t: any) => resolve(currencies, t.symbol)?.iso ?? t.symbol),
          from.iso,
          to.iso
        ),
        deadline: Number(built.deadline),
        recipient,
        transactions,
        attribution_tag: ATTRIBUTION_TAG,
        next_steps: nextSteps(transactions.length),
        notes: [
          'These transactions are unsigned. Cowrie never takes custody of funds and never asks for a key.',
          'Send them in order and wait for each to confirm before sending the next.',
          `feeCurrency is set to the USD₮ adapter, so gas is paid in stablecoin — you do not need any CELO.`,
          `min_amount_out reflects 0.5% slippage tolerance. The swap reverts rather than filling worse than that.`,
          `Valid until unix ${built.deadline}; after that the transaction reverts and you must request a new plan.`,
          // Reaching this point means Mento priced the pair, so the market is
          // trading for it — whatever a calendar might say.
          ...(isMarketOpen(now)
            ? []
            : ['Global FX markets are outside normal hours, but this pair priced anyway because it crosses no exchange rate.']),
        ],
      },
    }
  } catch (err) {
    return { ok: false, error: await classifyError(err, now, from.iso, to.iso) }
  }
}
