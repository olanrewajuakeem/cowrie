/**
 * Mint Cowrie's ERC-8004 agent identity on Celo mainnet.
 *
 * This is the first script that spends real money, so it is deliberately
 * cautious: it prints the full transaction, estimates the cost, and refuses to
 * broadcast until you type "yes".
 *
 * The interesting part is `feeCurrency`. The wallet holds USDT and zero CELO,
 * which would normally make it impossible to transact at all. Celo's fee
 * abstraction is built into the protocol at node level — not a paymaster, not a
 * relayer — so a transaction can nominate an ERC-20 to pay its own gas. That is
 * exactly the situation every autonomous agent is in, and it is why this
 * project can exist on a $3 budget.
 *
 * Run: npm run mint
 */
import { createWalletClient, createPublicClient, http, formatUnits, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { createInterface } from 'node:readline/promises'

process.loadEnvFile?.('.env')

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
const USDT_TOKEN = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as const
/** NOT the token address — Celo prices gas in 18 decimals, USDT has 6, so it
 *  is allowlisted through an adapter. Passing the token here is the classic
 *  way this fails. */
const USDT_FEE_ADAPTER = '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72' as const

const AGENT_URI =
  process.env.AGENT_URI ??
  'https://raw.githubusercontent.com/olanrewajuakeem/cowrie/main/agent-card.json'

const registryAbi = parseAbi([
  'function register(string agentURI) external returns (uint256 agentId)',
])
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)'])

const pk = process.env.PRIVATE_KEY
if (!pk) {
  console.error('PRIVATE_KEY missing. Create a .env file containing:')
  console.error('PRIVATE_KEY=0xyourkey')
  process.exit(1)
}

const account = privateKeyToAccount(pk as `0x${string}`)
const transport = http(process.env.CELO_RPC_URL)
const publicClient = createPublicClient({ chain: celo, transport })
const walletClient = createWalletClient({ account, chain: celo, transport })

console.log('=== ERC-8004 AGENT REGISTRATION ===\n')
console.log('network      Celo mainnet (42220)')
console.log('registry    ', IDENTITY_REGISTRY)
console.log('wallet      ', account.address)
console.log('agent URI   ', AGENT_URI)

// Confirm the agent card is actually reachable. The URI is written on-chain
// permanently; pointing it at a 404 would mean re-minting and paying twice.
console.log('\nchecking agent card is publicly reachable...')
const cardRes = await fetch(AGENT_URI)
if (!cardRes.ok) {
  console.error(`agent card returned HTTP ${cardRes.status}. Fix the URL before minting.`)
  process.exit(1)
}
const card = (await cardRes.json()) as { name?: string; skills?: unknown[] }
console.log(`  OK — "${card.name}", ${card.skills?.length ?? 0} skills declared`)

const [usdt, celoBalance] = await Promise.all([
  publicClient.readContract({
    address: USDT_TOKEN,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  }),
  publicClient.getBalance({ address: account.address }),
])

console.log('\nbalances')
console.log(`  USDT  ${formatUnits(usdt, 6)}`)
console.log(`  CELO  ${formatUnits(celoBalance, 18)}`)

if (usdt === 0n) {
  console.error('\nNo USDT. Nothing can pay for gas. Stopping.')
  process.exit(1)
}
if (celoBalance === 0n) {
  console.log('\n  Zero CELO — paying gas in USDT via fee abstraction.')
}

// Simulate first: this catches a bad ABI or a reverting call without spending.
console.log('\nsimulating...')
const { request, result } = await publicClient.simulateContract({
  account,
  address: IDENTITY_REGISTRY,
  abi: registryAbi,
  functionName: 'register',
  args: [AGENT_URI],
  feeCurrency: USDT_FEE_ADAPTER,
} as any)

console.log(`  simulation OK — would mint agent ID ${result}`)

const gas = await publicClient.estimateContractGas({
  account,
  address: IDENTITY_REGISTRY,
  abi: registryAbi,
  functionName: 'register',
  args: [AGENT_URI],
  feeCurrency: USDT_FEE_ADAPTER,
} as any)

console.log(`  estimated gas ${gas}`)
console.log(`  gas paid in USDT via adapter ${USDT_FEE_ADAPTER}`)

console.log('\nThis will send a REAL transaction on Celo mainnet and spend a small')
console.log('amount of your USDT on gas. The agent ID is permanent.\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('Type "yes" to broadcast, anything else to cancel: ')
rl.close()

if (answer.trim().toLowerCase() !== 'yes') {
  console.log('Cancelled. Nothing was sent.')
  process.exit(0)
}

console.log('\nbroadcasting...')
const hash = await walletClient.writeContract({ ...request, feeCurrency: USDT_FEE_ADAPTER } as any)
console.log('  tx hash', hash)
console.log('  https://celoscan.io/tx/' + hash)

console.log('\nwaiting for confirmation...')
const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log('  status  ', receipt.status)
console.log('  block   ', receipt.blockNumber)
console.log('  gas used', receipt.gasUsed)

// The agent ID is the ERC-721 token ID, carried in the Transfer event's third
// indexed topic.
const transfer = receipt.logs.find(
  (l) => l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
)
const agentId = transfer?.topics[3] ? BigInt(transfer.topics[3]).toString() : String(result)

console.log(`\n=== AGENT ID: ${agentId} ===`)
console.log('Registered at', IDENTITY_REGISTRY)
console.log('Save this — the hackathon registration asks for it.')

// Pin the read to the block the transaction landed in. Reading "latest" right
// after a receipt can hit a node that has not applied the block yet, which
// reports a spend of zero and makes fee abstraction look like it never ran.
const after = await publicClient.readContract({
  address: USDT_TOKEN,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
  blockNumber: receipt.blockNumber,
})
console.log(`\nUSDT spent on gas: ${formatUnits(usdt - after, 6)}`)
console.log(`USDT remaining:    ${formatUnits(after, 6)}`)
