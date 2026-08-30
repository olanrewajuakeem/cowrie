/**
 * Execute a swap through Cowrie's own API, end to end.
 *
 * This is the proof that the whole loop closes: ask the live service for a
 * plan, sign exactly what it returns, broadcast, then decode the transaction
 * from the chain and confirm the attribution tag was really recorded. The
 * hackathon rules are explicit that a tag which merely *looks* present is not
 * enough — verifyTx against the mined transaction is the only real check.
 *
 * Spends real money. Prints everything and refuses to broadcast until you
 * type "yes".
 *
 * Usage:
 *   npm run swap                                  (1 CELO -> USD by default)
 *   npm run swap -- --from USDT --to USD --amount 0.5
 *   npm run swap -- --api http://localhost:8080   (test against local server)
 */
import { createWalletClient, createPublicClient, http, formatUnits, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { verifyTx } from '@celo/attribution-tags'
import { createInterface } from 'node:readline/promises'

process.loadEnvFile?.('.env')

const USDT_TOKEN = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as const
const USDT_FEE_ADAPTER = '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72' as const

/** Minimal CLI parsing — `--key value` pairs. */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const API = arg('api', 'https://cowrie-seven.vercel.app')
const FROM = arg('from', 'CELO')
const TO = arg('to', 'USD')
const AMOUNT = arg('amount', '1')

const pk = process.env.PRIVATE_KEY
if (!pk) {
  console.error('PRIVATE_KEY missing from .env')
  process.exit(1)
}

const account = privateKeyToAccount(pk as `0x${string}`)
const transport = http(process.env.CELO_RPC_URL)
const publicClient = createPublicClient({ chain: celo, transport })
const walletClient = createWalletClient({ account, chain: celo, transport })

console.log('=== EXECUTE SWAP THROUGH COWRIE ===\n')
console.log('api      ', API)
console.log('wallet   ', account.address)
console.log('swap     ', `${AMOUNT} ${FROM} -> ${TO}\n`)

// Ask our own live service for a plan. Deliberately over HTTP rather than by
// importing buildSwap directly — this tests what an agent would actually get.
const res = await fetch(`${API}/swap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: TO, amount: AMOUNT, recipient: account.address }),
})

const body: any = await res.json()

if (!res.ok) {
  console.error(`Cowrie returned ${res.status}:`)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log(`expected out  ${body.expected_amount_out} ${body.to}`)
console.log(`minimum out   ${body.min_amount_out} ${body.to}  (0.5% slippage)`)
console.log(`route         ${body.route.join(' -> ')}`)
console.log(`cost          ${body.cost_percent}%`)
console.log(`tag           ${body.attribution_tag}`)
console.log(`\n${body.transactions.length} transaction(s) to send:`)
for (const [i, tx] of body.transactions.entries()) {
  console.log(`\n  ${i + 1}. ${tx.description}`)
  console.log(`     to          ${tx.to}`)
  console.log(`     feeCurrency ${tx.feeCurrency}`)
  console.log(`     data        ${tx.data.slice(0, 42)}...${tx.data.slice(-34)}`)
}

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const usdtBefore = (await publicClient.readContract({
  address: USDT_TOKEN,
  abi: erc20,
  functionName: 'balanceOf',
  args: [account.address],
})) as bigint
const celoBefore = await publicClient.getBalance({ address: account.address })

console.log(`\nbalances before:  ${formatUnits(celoBefore, 18)} CELO, ${formatUnits(usdtBefore, 6)} USDT`)
console.log('\nThis sends REAL transactions on Celo mainnet and spends real funds.\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('Type "yes" to broadcast: ')
rl.close()
if (answer.trim().toLowerCase() !== 'yes') {
  console.log('Cancelled. Nothing was sent.')
  process.exit(0)
}

// Send in order. The approval must confirm before the swap, or the swap
// reverts — which is exactly the failure an agent hits when a service hands
// back a swap without its approval.
const hashes: `0x${string}`[] = []
for (const [i, tx] of body.transactions.entries()) {
  console.log(`\n[${i + 1}/${body.transactions.length}] ${tx.description}`)
  // Use the fee values Cowrie returned. They are denominated in the fee
  // currency; letting viem estimate instead produces a cap priced in CELO,
  // which the node rejects as below the base fee.
  const hash = await walletClient.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value ?? '0'),
    feeCurrency: tx.feeCurrency as `0x${string}`,
    ...(tx.maxFeePerGas
      ? {
          maxFeePerGas: BigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
        }
      : {}),
  } as any)
  console.log(`  sent    ${hash}`)
  console.log(`  https://celoscan.io/tx/${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`  status  ${receipt.status}  (gas ${receipt.gasUsed})`)
  if (receipt.status !== 'success') {
    console.error('  Transaction reverted. Stopping before sending the rest.')
    process.exit(1)
  }
  hashes.push(hash)
}

// The part that actually matters: does the chain agree the tag is there?
console.log('\n=== VERIFYING ATTRIBUTION ===')
for (const hash of hashes) {
  const decoded = await verifyTx({ client: publicClient as any, hash })
  if (decoded) {
    const credited = decoded.codes.includes(body.attribution_tag)
    console.log(`${hash.slice(0, 12)}...  codes: ${decoded.codes.join(', ')}  ${credited ? 'CREDITED' : 'TAG MISSING'}`)
  } else {
    console.log(`${hash.slice(0, 12)}...  no attribution suffix found`)
  }
}

const usdtAfter = (await publicClient.readContract({
  address: USDT_TOKEN,
  abi: erc20,
  functionName: 'balanceOf',
  args: [account.address],
  blockNumber: await publicClient.getBlockNumber(),
})) as bigint
const celoAfter = await publicClient.getBalance({ address: account.address })

console.log(`\nbalances after:   ${formatUnits(celoAfter, 18)} CELO, ${formatUnits(usdtAfter, 6)} USDT`)
console.log(`CELO delta:       ${formatUnits(celoAfter - celoBefore, 18)}`)
console.log(`USDT delta:       ${formatUnits(usdtAfter - usdtBefore, 6)}  (negative = gas paid in USDT)`)
console.log('\nLeaderboard: https://dune.com/celo/agents-at-work-hackathon')
