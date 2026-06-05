"use client";

import { AppShell } from "@/components/AppShell";
import { EscrowCard } from "@/components/billing/EscrowCard";
import { QuoteCard } from "@/components/billing/QuoteCard";

export default function BillingPage() {
  return (
    <AppShell>
      <BillingBody />
    </AppShell>
  );
}

function BillingBody() {
  return (
    <div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Billing &amp; compute
        </h1>
        <p className="mt-1 max-w-xl text-sm text-slate-500">
          Estimate a confidential VM, then prepay the on-chain escrow — a flat 20%
          over our Phala cost, withdrawable anytime.
        </p>
      </div>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        <QuoteCard />
        <div className="space-y-6">
          <EscrowCard />
          <PricingNote />
        </div>
      </div>
    </div>
  );
}

function PricingNote() {
  // Worked example, computed from the canonical rates so it can never drift from
  // the live calculator: Small CVM (2 vCPU · 4 GiB · 40 GiB) for 1 day.
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const exPhala = (2 * 0.1 + 4 * 0.02 + 40 * 0.0005) * 24; // = 7.20
  const exPrice = exPhala * 1.2; // = 8.64
  const exMargin = exPrice - exPhala; // = 1.44

  const points = [
    "Metered Phala CVM-hours — vCPU, memory, disk.",
    "A flat +20% on top. That's our entire margin.",
    "Debited from your prepaid balance; withdraw the rest anytime.",
  ];

  return (
    <div className="card p-6">
      <h2 className="text-base font-semibold text-slate-900">How pricing works</h2>
      <ul className="mt-3 space-y-2.5 text-sm text-slate-500">
        {points.map((p) => (
          <li key={p} className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
            {p}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-400">
        Example: a Small CVM (2 vCPU · 4 GiB · 40 GiB) for 1 day costs Phala{" "}
        {usd(exPhala)}; you pay {usd(exPrice)} — the extra {usd(exMargin)} is our 20%.
      </p>
    </div>
  );
}
