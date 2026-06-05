"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Logo } from "@/components/Logo";
import { WalletButton } from "@/components/WalletButton";
import { useSession } from "@/components/SessionProvider";
import { WindowChrome } from "@/components/WindowChrome";

export default function LandingPage() {
  const { status, error } = useSession();
  const router = useRouter();

  // Once the wallet has signed in (SIWE), go straight to the console.
  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <header className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
        <Logo />
        <nav className="ml-auto flex items-center gap-3">
          <WalletButton />
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-20 pt-14 sm:px-6 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="animate-fade-in">
            <p className="eyebrow flex items-center gap-2.5">
              <span className="h-px w-7 bg-blue-600" />
              Deploy · seal · recover
            </p>
            <h1 className="display mt-5 text-5xl leading-[0.95] text-slate-900 sm:text-6xl">
              Sovereign agents
              <br />
              you <span className="text-blue-600">actually own</span>
            </h1>
            <p className="mt-6 max-w-md text-pretty text-lg leading-relaxed text-slate-500">
              Autonomous agents on disposable confidential compute. The box can
              vanish — its memory lives in TinyCloud, sealed to your wallet.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <WalletButton size="lg" />
              <Link href="/dashboard" className="btn-ghost px-5 py-3 text-base">
                Open console <span aria-hidden>→</span>
              </Link>
            </div>

            {status === "signing-in" && (
              <p className="mt-4 text-sm text-blue-600">
                Approve the signature in your wallet to continue…
              </p>
            )}
            {error && (
              <p className="mt-4 inline-block rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            )}
          </div>

          <div className="animate-fade-in lg:pl-6">
            <IdeaPanel />
          </div>
        </div>

        <FeatureGrid />
      </section>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[36rem] bg-[radial-gradient(38rem_26rem_at_72%_0%,rgba(37,99,235,0.08),transparent)]"
      />
    </div>
  );
}

function IdeaPanel() {
  return (
    <WindowChrome title="tinyagent · lifecycle" bodyClassName="p-6 shadow-glow" className="shadow-glow">
      <ol className="space-y-4">
        <Step n={1} title="Deploy" body="A lowkey pack on local Docker or a dstack Intel-TDX CVM." />
        <Step n={2} title="Seal" body="State snapshots to TinyCloud, encrypted to your wallet's key." />
        <Step n={3} title="Dispose" body="Tear it down or switch providers — recover and it remembers." />
        <Step n={4} title="Pay" body="Prepay an escrow at 20% over Phala cost. Withdraw the rest anytime." />
      </ol>
    </WindowChrome>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-600 font-display text-xs font-semibold text-white">
        {n}
      </span>
      <div>
        <p className="font-display text-sm font-semibold uppercase tracking-wide text-slate-900">
          {title}
        </p>
        <p className="mt-0.5 text-sm text-slate-500">{body}</p>
      </div>
    </li>
  );
}

function FeatureGrid() {
  const features = [
    {
      icon: <LockIcon />,
      title: "Self-custodied memory",
      body: "Encrypted in TinyCloud, content-addressed. Only your wallet can decrypt it.",
    },
    {
      icon: <ShieldIcon />,
      title: "Hardware attestation",
      body: "Every dstack CVM ships a TDX quote you can verify. Trust the math, not us.",
    },
    {
      icon: <CoinsIcon />,
      title: "Crypto-metered compute",
      body: "An on-chain escrow holds your balance. We debit metered usage — never more.",
    },
  ];
  return (
    <div className="mt-20 grid gap-4 sm:grid-cols-3">
      {features.map((f) => (
        <div key={f.title} className="card p-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600">
            {f.icon}
          </div>
          <h3 className="mt-3 text-base font-semibold text-slate-900">{f.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{f.body}</p>
        </div>
      ))}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function CoinsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="6" />
      <path d="M16.5 9.5A6 6 0 1 1 9.5 16.5" />
    </svg>
  );
}
