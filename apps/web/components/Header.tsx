"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";
import { useSession } from "./SessionProvider";
import { cx } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Agents" },
  { href: "/billing", label: "Billing" },
];

export function Header() {
  const pathname = usePathname();
  const { status, signOut } = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-paper backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="shrink-0">
          <Logo />
        </Link>

        {status === "authenticated" && (
          <nav className="ml-2 hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-slate-100 text-slate-900"
                      : "text-slate-500 hover:text-slate-700",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2.5">
          <WalletButton />
          {status === "authenticated" && (
            <button
              onClick={signOut}
              className="btn-ghost btn-sm"
              title="Sign out and disconnect"
            >
              <LogoutIcon />
              <span className="hidden md:inline">Logout</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}
