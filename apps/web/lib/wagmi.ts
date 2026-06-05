/**
 * wagmi v2 + RainbowKit config.
 *
 * Chains: a local Anvil/Foundry node (31337, where the dev escrow is deployed)
 * plus Sepolia, Base and Mainnet. The `/api/billing/config` endpoint is the
 * source of truth for which chain the escrow lives on; this list only
 * determines which networks the wallet may connect to.
 *
 * We build connectors explicitly (rather than via `getDefaultConfig`) so the
 * WalletConnect connector — which pulls in an IndexedDB-backed store that isn't
 * available during server prerendering — is only included when a real
 * WalletConnect project id is configured. Injected/browser wallets (MetaMask,
 * Rabby, Coinbase) always work, and the SSR build stays clean.
 */
import {
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { base, mainnet, sepolia } from "wagmi/chains";
import { defineChain } from "viem";

/**
 * E2E mode (NEXT_PUBLIC_E2E=1): a single programmatic connector backed by a real
 * Anvil dev account. The EIP-1193 provider forwards every RPC — including
 * `personal_sign` — straight to Anvil, which holds the key and signs for real.
 * So SIWE and on-chain top-ups are genuine; only the wallet *UI* is automated.
 * Never enabled in production builds.
 */
export const IS_E2E = process.env.NEXT_PUBLIC_E2E === "1";
const E2E_RPC = process.env.NEXT_PUBLIC_E2E_RPC || "http://127.0.0.1:8545";
const E2E_ACCOUNT = (
  process.env.NEXT_PUBLIC_E2E_ACCOUNT || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
).toLowerCase();

function anvilEip1193Provider() {
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const r = await fetch(E2E_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  return {
    on: () => {},
    removeListener: () => {},
    request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [E2E_ACCOUNT];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return rpc(method, params);
    },
  };
}

function e2eConnector() {
  return injected({
    target: () => ({
      id: "anvilDev",
      name: "Anvil Dev",
      provider: anvilEip1193Provider() as never,
    }),
  });
}

/** Local Anvil / Foundry dev node (where the dev escrow contract lives). */
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
  testnet: true,
});

export const SUPPORTED_CHAINS = [anvil, sepolia, base, mainnet] as const;

type WagmiConfig = ReturnType<typeof createConfig>;

let _config: WagmiConfig | undefined;

/**
 * Lazily build the wagmi config (client-side singleton). Connector construction
 * pulls in an IndexedDB-backed store, so we must NOT do this at module load —
 * that would run during the server prerender and throw `indexedDB is not
 * defined`. Callers (the client provider tree) invoke this after mount.
 */
export function getWagmiConfig(): WagmiConfig {
  if (_config) return _config;

  const walletConnectProjectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";
  const hasWalletConnect = walletConnectProjectId.length > 0;

  const recommended = [
    injectedWallet,
    metaMaskWallet,
    rainbowWallet,
    coinbaseWallet,
  ];
  if (hasWalletConnect) recommended.push(walletConnectWallet);

  const connectors = IS_E2E
    ? [e2eConnector()]
    : connectorsForWallets(
        [{ groupName: "Wallets", wallets: recommended }],
        {
          appName: "TinyAgent",
          // RainbowKit requires a projectId; a placeholder is fine because the
          // WalletConnect wallet is only added when a real id is present.
          projectId: walletConnectProjectId || "tinyagent-dev-placeholder",
        },
      );

  _config = createConfig({
    chains: SUPPORTED_CHAINS,
    connectors,
    ssr: true,
    transports: {
      [anvil.id]: http(),
      [sepolia.id]: http(),
      [base.id]: http(),
      [mainnet.id]: http(),
    },
  });
  return _config;
}

/** Friendly chain name from an id, for display. */
export function chainName(chainId: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ?? `chain ${chainId}`;
}
