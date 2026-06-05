"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSession } from "./SessionProvider";
import { cx, shortAddress } from "@/lib/utils";
import { useMounted } from "@/lib/useMounted";

/**
 * Wallet + SIWE control. The primary flow is intentionally simple:
 * connect a wallet, sign the SIWE message, then show the signed-in address.
 * Chain switching stays available through RainbowKit account details instead
 * of competing with the console's main actions.
 */
export function WalletButton({ size = "md" }: { size?: "md" | "lg" }) {
  const { status, signIn } = useSession();
  const mounted = useMounted();
  const big = size === "lg";

  // Before client mount the wallet provider tree isn't available; show a static
  // placeholder that matches the connect button so layout doesn't shift.
  if (!mounted) {
    return (
      <button className={cx("btn-primary", big && "px-6 py-3 text-base")} disabled>
        <WalletIcon />
        Connect Wallet
      </button>
    );
  }

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!ready) {
          return (
            <button
              className={cx("btn-ghost", big && "px-6 py-3 text-base")}
              disabled
              aria-hidden
            >
              …
            </button>
          );
        }

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              className={cx("btn-primary", big && "px-6 py-3 text-base")}
            >
              <WalletIcon />
              Connect Wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button onClick={openAccountModal} className="btn-danger">
              Switch network
            </button>
          );
        }

        if (status !== "authenticated") {
          return (
            <button
              onClick={signIn}
              disabled={status === "signing-in"}
              className={cx("btn-primary", big && "px-6 py-3 text-base")}
            >
              {status === "signing-in" ? (
                <>
                  <Spinner />
                  Check wallet…
                </>
              ) : (
                <>
                  <ShieldIcon />
                  Sign in
                </>
              )}
            </button>
          );
        }

        return (
          <div className="flex items-center gap-2">
            <button
              onClick={openAccountModal}
              className="btn-ghost"
              title="Wallet account"
            >
              <span className="font-mono text-xs">
                {shortAddress(account.address)}
              </span>
              {account.displayBalance && (
                <span className="hidden text-xs text-slate-500 md:inline">
                  · {account.displayBalance}
                </span>
              )}
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M16 12h.01M3 9h18" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
