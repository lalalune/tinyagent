"use client";

import { useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { useBillingBalance, useBillingConfig, qk } from "@/lib/hooks";
import {
  BILLING_ABI,
  ERC20_ABI,
  formatUnitsUsd,
  formatUsd,
  usdToUnits,
} from "@/lib/contracts";
import { chainName } from "@/lib/wagmi";
import { cx } from "@/lib/utils";

type Step = "idle" | "approving" | "depositing" | "withdrawing";

const QUICK_AMOUNTS = [10, 25, 50, 100];

/**
 * Prepaid escrow panel: shows the on-chain balance and drives the real
 * approve → deposit top-up flow (and withdraw) with the user's wallet. The
 * balance is read straight from the escrow contract via the connected wallet's
 * RPC, with the control-plane's `/api/billing/balance` as a fallback.
 */
export function EscrowCard() {
  const { address, chainId: walletChainId } = useAccount();
  const { data: config } = useBillingConfig();
  const balanceQuery = useBillingBalance(address);
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: config?.chainId });
  const { writeContractAsync } = useWriteContract();
  const toast = useToast();
  const qc = useQueryClient();

  const [amountUsd, setAmountUsd] = useState<string>("25");
  const [step, setStep] = useState<Step>("idle");

  const decimals = config?.decimals ?? 6;
  const contract = config?.contract as `0x${string}` | undefined;
  const token = config?.token as `0x${string}` | undefined;
  const onWrongChain =
    !!config &&
    walletChainId !== undefined &&
    walletChainId !== config.chainId;

  // On-chain escrow balance, read straight from the contract (authoritative).
  const onchainBalance = useReadContract({
    abi: BILLING_ABI,
    address: contract,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: config?.chainId,
    query: { enabled: !!contract && !!address },
  });

  // Wallet's spendable token balance (so users see what they can deposit).
  const tokenBalance = useReadContract({
    abi: ERC20_ABI,
    address: token,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: config?.chainId,
    query: { enabled: !!token && !!address },
  });

  const escrowUnits: bigint = useMemo(() => {
    if (onchainBalance.data !== undefined) {
      return onchainBalance.data as bigint;
    }
    const s = balanceQuery.data?.balanceUnits;
    if (s) {
      try {
        return BigInt(s);
      } catch {
        return 0n;
      }
    }
    return 0n;
  }, [onchainBalance.data, balanceQuery.data]);

  const parsedUsd = Number(amountUsd);
  const amountValid = Number.isFinite(parsedUsd) && parsedUsd > 0;
  const units = amountValid ? usdToUnits(parsedUsd, decimals) : 0n;
  const busy = step !== "idle";

  function refreshBalances() {
    onchainBalance.refetch();
    tokenBalance.refetch();
    balanceQuery.refetch();
    if (address) qc.invalidateQueries({ queryKey: qk.billingBalance(address) });
  }

  async function confirm(hash: `0x${string}`) {
    if (!publicClient) return;
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // ---- top up: approve then deposit ----------------------------------
  const onTopUp = async () => {
    if (!amountValid || !address) return;

    if (!contract || !token) {
      toast.push({ kind: "error", title: "Billing not configured" });
      return;
    }
    if (onWrongChain) {
      toast.push({
        kind: "error",
        title: "Wrong network",
        message: `Switch to ${chainName(config!.chainId)} to top up.`,
      });
      return;
    }

    const id = toast.push({
      kind: "loading",
      title: `Approving ${formatUsd(parsedUsd)}…`,
      message: "Confirm the approval in your wallet",
    });
    try {
      setStep("approving");
      const approveHash = await writeContractAsync({
        abi: ERC20_ABI,
        address: token,
        functionName: "approve",
        args: [contract, units],
        chainId: config!.chainId,
      });
      toast.update(id, {
        kind: "loading",
        title: "Approval submitted",
        message: "Waiting for confirmation…",
      });
      await confirm(approveHash);

      setStep("depositing");
      toast.update(id, {
        kind: "loading",
        title: "Depositing…",
        message: "Confirm the deposit in your wallet",
      });
      const depositHash = await writeContractAsync({
        abi: BILLING_ABI,
        address: contract,
        functionName: "deposit",
        args: [units],
        chainId: config!.chainId,
      });
      await confirm(depositHash);

      refreshBalances();
      toast.update(id, {
        kind: "success",
        title: `Deposited ${formatUsd(parsedUsd)}`,
        message: "Prepaid balance updated on-chain.",
      });
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Top-up failed",
        message: friendlyTxError(e),
      });
    } finally {
      setStep("idle");
    }
  };

  // ---- withdraw the full prepaid balance -----------------------------
  const onWithdraw = async () => {
    if (escrowUnits <= 0n || !address) return;

    if (!contract) return;
    if (onWrongChain) {
      toast.push({
        kind: "error",
        title: "Wrong network",
        message: `Switch to ${chainName(config!.chainId)} to withdraw.`,
      });
      return;
    }

    const id = toast.push({
      kind: "loading",
      title: "Withdrawing…",
      message: "Confirm the withdrawal in your wallet",
    });
    try {
      setStep("withdrawing");
      const hash = await writeContractAsync({
        abi: BILLING_ABI,
        address: contract,
        functionName: "withdraw",
        args: [escrowUnits],
        chainId: config!.chainId,
      });
      await confirm(hash);
      refreshBalances();
      toast.update(id, {
        kind: "success",
        title: "Withdrawn",
        message: "Unused balance returned to your wallet.",
      });
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Withdraw failed",
        message: friendlyTxError(e),
      });
    } finally {
      setStep("idle");
    }
  };

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Prepaid balance
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            On-chain escrow · withdraw anytime
          </p>
        </div>
        {config && <Badge tone="neutral">{chainName(config.chainId)}</Badge>}
      </div>

      <div className="mt-4">
        <span className="text-4xl font-bold tracking-tight text-slate-900">
          {formatUnitsUsd(escrowUnits, decimals)}
        </span>
      </div>
      {tokenBalance.data !== undefined && (
        <p className="mt-1 text-xs text-slate-400">
          Wallet: {formatUnitsUsd(tokenBalance.data as bigint, decimals)}{" "}
          available to deposit
        </p>
      )}

      {onWrongChain && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2">
          <p className="text-xs text-amber-200">
            Wallet is on {chainName(walletChainId!)}; escrow is on{" "}
            {chainName(config!.chainId)}.
          </p>
          <button
            className="btn-ghost btn-sm shrink-0"
            onClick={() => switchChain({ chainId: config!.chainId })}
          >
            Switch
          </button>
        </div>
      )}

      {/* Top up */}
      <div className="mt-6">
        <label className="label">Top up (USD)</label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[8rem] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              $
            </span>
            <input
              className="input pl-6"
              inputMode="decimal"
              value={amountUsd}
              onChange={(e) =>
                setAmountUsd(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="25"
              disabled={busy}
            />
          </div>
          <button
            className="btn-primary"
            onClick={onTopUp}
            disabled={!amountValid || busy}
          >
            {step === "approving"
              ? "Approving…"
              : step === "depositing"
                ? "Depositing…"
                : "Top up"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_AMOUNTS.map((a) => (
            <button
              key={a}
              onClick={() => setAmountUsd(String(a))}
              disabled={busy}
              className={cx(
                "rounded-lg border px-2.5 py-1 text-xs transition",
                Number(amountUsd) === a
                  ? "border-blue-400 bg-blue-50 text-blue-700"
                  : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700",
              )}
            >
              ${a}
            </button>
          ))}
        </div>
        {amountValid && (
          <p className="mt-2 text-xs text-slate-400">
            Deposits {formatUsd(parsedUsd)} to the escrow.
          </p>
        )}
      </div>

      {/* Withdraw */}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <p className="text-xs text-slate-500">
          Withdraw your unused balance anytime.
        </p>
        <button
          className="btn-ghost btn-sm shrink-0"
          onClick={onWithdraw}
          disabled={escrowUnits <= 0n || busy}
        >
          {step === "withdrawing" ? "Withdrawing…" : "Withdraw all"}
        </button>
      </div>
    </div>
  );
}

function friendlyTxError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|rejected the request|denied/i.test(msg))
    return "Transaction rejected in wallet.";
  if (/insufficient funds/i.test(msg)) return "Insufficient funds for gas.";
  return msg.split("\n")[0].slice(0, 160);
}
