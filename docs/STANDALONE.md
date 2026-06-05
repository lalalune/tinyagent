# TinyAgent Repo Framing

`/Users/shawwalters/tinycloud-node/tinyagent` is the TinyAgent source of truth.

The older `/Users/shawwalters/tinyagent` checkout is a divergent legacy tree. The web console has been copied into `apps/web` as a self-contained Next.js app. It also contains useful historical material, including contracts, a billing package, a server package, and older e2e harnesses, but those remaining files were not overlaid into active package paths because they do not match the currently verified Bun/TypeScript implementation.

## Recommendation

Keep TinyAgent as an in-tree standalone workspace for now, not a Git submodule.

Reasons:

- TinyAgent still evolves with the local TinyCloud node and SDK behavior.
- The two existing TinyAgent trees diverged enough that a submodule would obscure ownership rather than clarify it.
- Keeping it in-tree allows atomic fixes across TinyCloud and TinyAgent while the provider, backup, attest, and CLI contracts settle.
- This directory already has standalone repo scaffolding: package metadata, lockfile, license, CI workflow, README, and ignore files.

Treat this as a subtree candidate. When the API boundary stabilizes, extract it into its own repository while preserving history.

## Extraction Path

From the parent repository:

```sh
git subtree split --prefix=tinyagent -b tinyagent-standalone
git remote add tinyagent git@github.com:tinycloudlabs/tinyagent.git
git push tinyagent tinyagent-standalone:main
```

If a cleaner rewritten history is preferred:

```sh
git clone /path/to/tinycloud-node tinyagent-extract
cd tinyagent-extract
git filter-repo --path tinyagent/ --path-rename tinyagent/:
```

## Deferred Legacy Scope

- Wire `apps/web` to a verified current control-plane and add it to root CI once the backend contract is restored. Standalone `npm run lint` and `npm run build` currently pass inside `apps/web`.
- Re-audit the legacy `contracts` and `packages/billing` code before restoring billing flows.
- Re-audit the legacy `packages/server` control plane before restoring cloud mode.
- Reconcile legacy `test/e2e` harnesses with the current provider-core conformance tests.
- Treat production dstack deployment as externally unverified until the live Phala/dstack validation in `README.md` passes with real credentials and service access.

The verified surface is the CLI/package workspace described in `README.md`.
Root format, lint, typecheck, build, and test scripts intentionally exclude deferred legacy scope.
