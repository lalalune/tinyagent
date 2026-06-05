"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect } from "wagmi";
import { useSession } from "./SessionProvider";

/**
 * E2E only (NEXT_PUBLIC_E2E=1): auto-connect the Anvil dev wallet and run the
 * real SIWE sign-in, so the authenticated console can be exercised end to end
 * without manual wallet clicks. The signature is genuine - Anvil holds the key
 * and signs it. Rendered only in E2E builds; a no-op otherwise.
 */
export function E2EAutoLogin() {
  const { connect, connectors } = useConnect();
  const { isConnected } = useAccount();
  const { status, signIn } = useSession();
  const attemptsRef = useRef(0);

  useEffect(() => {
    const enabled =
      new URLSearchParams(window.location.search).get("e2eAutoLogin") === "1";
    if (!enabled) return;

    if (!isConnected) {
      const c = connectors[0];
      if (c) connect({ connector: c });
      return;
    }

    if (status === "unauthenticated" && attemptsRef.current < 3) {
      attemptsRef.current += 1;
      const timeout = window.setTimeout(() => {
        void signIn();
      }, 250);
      return () => window.clearTimeout(timeout);
    }
  }, [isConnected, status, connect, connectors, signIn]);

  return null;
}
