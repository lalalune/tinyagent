"use client";

/**
 * Session context: bridges the connected wallet (wagmi) with the control-plane
 * SIWE session (httpOnly cookie). Exposes the authenticated address plus a
 * `signIn` action that runs the full nonce → SIWE message → sign → verify flow.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { SiweMessage } from "siwe";
import { useAccount, useChainId, useDisconnect, useSignMessage } from "wagmi";
import { api } from "@/lib/api";

export type SessionStatus =
  | "loading" // checking existing cookie session
  | "unauthenticated" // wallet may be connected, but no server session
  | "signing-in" // SIWE flow in progress
  | "authenticated"; // server session active

interface SessionContextValue {
  status: SessionStatus;
  /** Address the control-plane considers authenticated (lower/checksum as returned). */
  address?: string;
  error?: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

/**
 * SSR / pre-hydration placeholder. The wallet provider tree is client-only (its
 * connectors aren't available during server prerendering), so before mount we
 * supply a neutral "loading" session whose actions are no-ops. The real
 * <SessionProvider> takes over on the client.
 */
export function SessionLoadingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const value = useMemo<SessionContextValue>(
    () => ({
      status: "loading",
      address: undefined,
      error: undefined,
      signIn: async () => {},
      signOut: async () => {},
      clearError: () => {},
    }),
    [],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { address: walletAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();

  const [status, setStatus] = useState<SessionStatus>("loading");
  const [address, setAddress] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // On mount, check for an existing server session. (No ref guard: under React
  // StrictMode the mount→unmount→remount cycle would cancel the first probe and
  // a ref guard would then block the retry, hanging on "loading" forever.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        if (me?.address) {
          setAddress(me.address);
          setStatus("authenticated");
        } else {
          setStatus("unauthenticated");
        }
      } catch {
        if (!cancelled) setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If the wallet disconnects, drop the local notion of being signed in (the
  // server cookie may persist, but the UX should require a connected wallet).
  useEffect(() => {
    if (!isConnected && status === "authenticated") {
      setStatus("unauthenticated");
      setAddress(undefined);
    }
  }, [isConnected, status]);

  const signIn = useCallback(async () => {
    if (!walletAddress) {
      setError("Connect a wallet first.");
      return;
    }
    setError(undefined);
    setStatus("signing-in");
    try {
      const nonce = await api.nonce();
      const message = new SiweMessage({
        domain: window.location.host,
        address: walletAddress,
        statement:
          "Sign in to TinyAgent. This proves you own this wallet so we can seal your agents' memory to it.",
        uri: window.location.origin,
        version: "1",
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });
      const prepared = message.prepareMessage();
      const signature = await signMessageAsync({ message: prepared });
      const verified = await api.verify(prepared, signature);
      setAddress(verified.address);
      setStatus("authenticated");
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Sign-in failed. Please try again.";
      // User-rejected signature is common; keep it friendly.
      setError(
        /rejected|denied|User rejected/i.test(msg)
          ? "Signature request was rejected."
          : msg,
      );
      setStatus("unauthenticated");
    }
  }, [walletAddress, chainId, signMessageAsync]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best-effort */
    }
    setAddress(undefined);
    setStatus("unauthenticated");
    disconnect();
  }, [disconnect]);

  const clearError = useCallback(() => setError(undefined), []);

  const value = useMemo<SessionContextValue>(
    () => ({ status, address, error, signIn, signOut, clearError }),
    [status, address, error, signIn, signOut, clearError],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
