"use client";

/**
 * Client provider tree: wagmi → react-query → RainbowKit → app session.
 * Mounted once from the root layout.
 */
import "@rainbow-me/rainbowkit/styles.css";
import {
  RainbowKitProvider,
  darkTheme,
} from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";
import { getWagmiConfig, IS_E2E } from "@/lib/wagmi";
import { SessionLoadingProvider, SessionProvider } from "./SessionProvider";
import { E2EAutoLogin } from "./E2EAutoLogin";
import { ToastProvider } from "./ui/Toast";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // The wagmi/RainbowKit tree is client-only: building its wallet connectors
  // pulls in an IndexedDB-backed store that isn't available during server
  // prerendering. We render QueryClient + Toast on the server (so pages still
  // produce HTML) plus a neutral "loading" session, then mount the live wallet
  // tree on the client after hydration. This keeps `next build` output clean
  // and avoids hydration mismatches (server and first client render match).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionLoadingProvider>{children}</SessionLoadingProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }

  return (
    <WalletProviders queryClient={queryClient}>{children}</WalletProviders>
  );
}

/** Client-only subtree; `getWagmiConfig()` is evaluated here (never on server). */
function WalletProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  const [config] = useState(() => getWagmiConfig());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          theme={darkTheme({
            accentColor: "#2563eb",
            accentColorForeground: "#070a0c",
            borderRadius: "large",
            overlayBlur: "small",
          })}
        >
          <ToastProvider>
            <SessionProvider>
              {IS_E2E && <E2EAutoLogin />}
              {children}
            </SessionProvider>
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
