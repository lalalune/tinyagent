"use client";

import Link from "next/link";
import { Header } from "./Header";
import { WalletButton } from "./WalletButton";
import { useSession } from "./SessionProvider";
import { Logo } from "./Logo";

/**
 * Layout + auth gate for the signed-in console pages. Renders the header always,
 * and gates the page body on the SIWE session state with friendly fallbacks.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, error } = useSession();

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {status === "loading" && <LoadingGate />}
        {(status === "unauthenticated" || status === "signing-in") && (
          <AuthGate error={error} signing={status === "signing-in"} />
        )}
        {status === "authenticated" && (
          <div className="animate-fade-in">{children}</div>
        )}
      </main>
      <Footer />
    </div>
  );
}

function LoadingGate() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-slate-500">
      <svg className="animate-spin text-blue-600" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p className="text-sm">Restoring session…</p>
    </div>
  );
}

function AuthGate({
  error,
  signing,
}: {
  error?: string;
  signing: boolean;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center text-center">
      <Logo withWordmark={false} className="scale-150" />
      <h1 className="mt-6 text-2xl font-semibold text-slate-900">
        Sign in to your console
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        Connect your wallet and sign a message to prove ownership. Your agents&apos;
        memory is sealed to this address — no password, no account.
      </p>
      <div className="mt-6">
        <WalletButton size="lg" />
      </div>
      {signing && (
        <p className="mt-4 text-xs text-blue-600">
          Approve the signature request in your wallet…
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </p>
      )}
      <Link
        href="/"
        className="mt-8 text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
      >
        ← Back to home
      </Link>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 py-5">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-xs text-slate-400 sm:px-6">
        <span className="font-display uppercase tracking-[0.16em]">TinyAgent</span>
        <span>Non-custodial · your keys, your agent</span>
      </div>
    </footer>
  );
}
