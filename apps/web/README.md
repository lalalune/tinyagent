# TinyAgent — web console

A standalone Next.js 14 (App Router) console for **TinyAgent**: a wallet-login
cloud to deploy and manage sovereign agents and pay for compute with an Ethereum
wallet. _Compute is disposable; your agent's memory lives in TinyCloud, sealed to
your wallet._

This app is self-contained — it has its own `package.json` and dependencies and
does **not** touch the monorepo workspace.

## Stack

- **Next.js 14** (App Router) · **React 18** · **TypeScript** (strict)
- **wagmi v2** + **viem v2** + **RainbowKit** for wallet + chain
- **siwe** for Sign-In with Ethereum
- **@tanstack/react-query** for data fetching/cache
- **Tailwind CSS** (dark theme)

## Quick start

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000
```

Then open the app, click **Connect Wallet**, **Sign in** (SIWE), and you land on
the dashboard. The console expects a TinyAgent control-plane at
`NEXT_PUBLIC_CONTROL_PLANE_URL`; there is no mock/demo backend in this copy.

## Build

```bash
cd apps/web
npm run build      # next build — must be green
npm run start      # serve the production build
npm run lint       # next lint
```

## Configuration

Copy `.env.example` to `.env.local` and adjust:

| Var | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_CONTROL_PLANE_URL` | `http://localhost:8088` | Control-plane base URL |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | _(empty)_ | WalletConnect Cloud id (optional; injected wallets work without it) |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | `31337` | UI hint for the expected chain (billing config is authoritative) |

### Control-plane dependency

Point `NEXT_PUBLIC_CONTROL_PLANE_URL` at your backend. The client sends
`credentials: 'include'` so the httpOnly session cookie set by
`POST /api/auth/verify` is used on every request. Make sure the control-plane
sets CORS to allow this origin with credentials.

## Structure

```
apps/web/
├── app/                      # App Router pages
│   ├── layout.tsx            # root layout + providers
│   ├── page.tsx              # landing ("Sovereign agents you actually own.")
│   ├── dashboard/page.tsx    # agent list, deploy, backup/recover/down/attestation
│   ├── billing/page.tsx      # quote, prepaid escrow, top-up/withdraw
│   └── not-found.tsx
├── components/
│   ├── Providers.tsx         # wagmi → react-query → RainbowKit → session → toast
│   ├── SessionProvider.tsx   # SIWE sign-in + session state
│   ├── Header / AppShell / WalletButton / Logo
│   ├── agents/               # AgentCard, DeployModal, AttestationModal, TunnelHintModal
│   ├── billing/              # QuoteCard, EscrowCard (approve+deposit / withdraw)
│   └── ui/                   # Modal, Toast, Badge, ConfirmDialog, CopyButton
└── lib/
    ├── api.ts                # typed live control-plane client
    ├── types.ts              # API contract types
    ├── contracts.ts          # billing/ERC20 ABIs + USD↔units math
    ├── wagmi.ts              # chains + RainbowKit config
    ├── hooks.ts              # react-query hooks
    └── utils.ts              # formatting helpers
```

## On-chain top-up

The billing page reads the escrow + ERC20 addresses from
`GET /api/billing/config`, then drives a two-step **approve → deposit** flow with
the connected wallet (`useWriteContract`). USD is converted to token base units
with `units = ceil(usd × 10^decimals)` (USDC = 6dp). **Withdraw** returns the
unused prepaid balance.
