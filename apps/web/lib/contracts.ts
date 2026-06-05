/**
 * On-chain ABIs + unit math for the TinyAgentBilling escrow and its ERC20.
 * Mirrors the human-readable ABIs in @tinyagent/billing.
 */

export const BILLING_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Convert a USD amount to integer token units, rounding UP — identical to
 * @tinyagent/billing `usdToUnits`. For USDC (6dp): units = ceil(usd * 1e6).
 */
export function usdToUnits(usd: number, decimals = 6): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.ceil(usd * 10 ** decimals));
}

/** Convert integer token units back to a USD number for display. */
export function unitsToUsd(units: bigint, decimals = 6): number {
  return Number(units) / 10 ** decimals;
}

/** Format token base units as a $-prefixed USD string. */
export function formatUnitsUsd(
  units: bigint | string | undefined,
  decimals = 6,
): string {
  if (units === undefined) return "$0.00";
  const big = typeof units === "string" ? safeBigInt(units) : units;
  return formatUsd(unitsToUsd(big, decimals));
}

export function formatUsd(usd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(usd);
}

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
