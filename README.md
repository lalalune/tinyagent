# TinyAgent

TinyAgent is a Bun/TypeScript CLI and package workspace for running Lowkey agent packs with TinyCloud-backed encrypted backup and restore.

## Repository status

This directory is the TinyAgent source of truth. It is currently kept in-tree under `tinycloud-node/tinyagent` as a standalone workspace and subtree candidate, not as a Git submodule.

The older `~/tinyagent` checkout is divergent legacy material. Its web console has been copied into `apps/web` as a self-contained Next.js app. The legacy contracts, billing package, server package, and older e2e harnesses are still deferred because they are not part of the currently verified implementation. See `docs/STANDALONE.md` for the extraction plan and deferred legacy-porting scope.

## Visual docs

- `docs/SCREENSHOTS.md`: rendered CLI screenshots from real command output.
- `docs/FLOW.md`: Mermaid flow diagram for CLI, provider, backup, TinyCloud, and attestation boundaries.

## Web console

The GUI lives in `apps/web`. It is a standalone Next.js app with its own `package.json` and `package-lock.json`.

```sh
cd apps/web
npm install
npm run dev
npm run build
```

The console currently expects a live TinyAgent control-plane at `NEXT_PUBLIC_CONTROL_PLANE_URL` and does not include a mock backend.

## Verified CLI surface

```sh
bun run build
./dist/tinyagent --version
./dist/tinyagent agents list --json
./dist/tinyagent agents info openclaw --json
./dist/tinyagent attest verify --json --doc <attestation.json> --expected-runner-compose --phala-verify-url <phala-verify-url>
./dist/tinyagent attest verify --json --deployment --project-dir ./agent --expected-runner-compose --phala-verify-url <phala-verify-url>
```

Local project lifecycle:

```sh
./dist/tinyagent init --json --project-dir ./agent --agent ada --pack openclaw --registry test/fixtures/lowkey-registry.json
./dist/tinyagent deploy --json --project-dir ./agent
./dist/tinyagent status --json --project-dir ./agent
./dist/tinyagent tunnel --json --project-dir ./agent
./dist/tinyagent backup --json --project-dir ./agent --space space --signature-hex <wallet-signature-hex>
./dist/tinyagent down --json --project-dir ./agent
./dist/tinyagent recover --json --project-dir ./agent --space space --signature-hex <wallet-signature-hex>
```

The local lifecycle persists project state and backup data through local filesystem-backed stores. Add `deploy --execute-provider` to run the Lowkey pack inside `tinyagent-runner:test` through Docker. The `dstack-cvm` provider is wired through the Phala CLI, but real Phala Cloud deployment evidence still requires live credentials and service access; the current dstack simulator is package-local and must not be treated as production deployment behavior.

Messaging bridge and portable device-key sync are outside the current verified surface. There is no TinyAgent device key to migrate, so portability warnings for that path are tracked as unsupported until messaging exists.

## dstack validation status

The Phala Cloud validation test is skipped unless explicitly enabled. When enabled with real credentials and service access, it preflights the local Phala CLI, deploys a `dstack-cvm` project, verifies persisted attestation material, backs up state, tears the deployment down, and recovers state.

```sh
phala login
# or export PHALA_CLOUD_API_KEY=<phala-api-key>
# If phala is not globally installed:
# export TINYAGENT_PHALA_COMMAND="bunx phala"

./dist/tinyagent preflight dstack --json \
  --phala-verify-url <phala-verify-url>

TINYAGENT_DSTACK_LIVE=1 \
TINYAGENT_PHALA_VERIFY_URL=<phala-verify-url> \
TINYAGENT_DSTACK_SIGNATURE_HEX=<wallet-signature-hex> \
bunx vitest run packages/cli/src/dstack-live.test.ts
```

Persisted deployment attestation can be checked without extracting `.tinyagent/deployment.json`:

```sh
./dist/tinyagent attest verify --json \
  --deployment \
  --project-dir ./agent \
  --expected-runner-compose \
  --phala-verify-url <phala-verify-url>
```

Optional dstack test inputs:

- `TINYAGENT_PHALA_BIN`: Phala CLI binary, default `phala`.
- `TINYAGENT_PHALA_COMMAND`: argv-style Phala command prefix such as `bunx phala`; takes precedence over `TINYAGENT_PHALA_BIN`.
- `TINYAGENT_DSTACK_RUNNER_IMAGE`: runner image, default `tinyagent-runner:test`.
- `TINYAGENT_DSTACK_PACK`: pack name, default `codex-cli`.
- `TINYAGENT_DSTACK_ENV`: comma- or newline-separated `KEY=VALUE` entries passed to `deploy --env`.
- `TINYAGENT_DSTACK_TUNNEL_PORT`: port name or number to check after attestation for a ported pack.

Production dstack support remains externally unverified until that live test passes against real Phala Cloud access and the resulting CVM attestation matches the committed runner compose hash.

## Pack matrix

The normalized pack metadata comes from `test/fixtures/lowkey-registry.json`.

| Pack          | State                            | Ports          | Model modes                                                             | Caveats                                                                                                          |
| ------------- | -------------------------------- | -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `openclaw`    | `~/.openclaw`                    | `gateway:3001` | `us.anthropic.claude-opus-4-6-v1`, `openai-compatible-proxy`, `api-key` | none                                                                                                             |
| `claude-code` | none                             | none           | `us.anthropic.claude-sonnet-4-6`                                        | none                                                                                                             |
| `codex-cli`   | none                             | none           | `gpt-5.4`                                                               | requires OpenAI API key; compatible profiles: headless, interactive-cli                                          |
| `kiro-cli`    | none                             | none           | `gpt-5.4`                                                               | interactive CLI only; requires Kiro API key for headless mode; compatible profiles: interactive-cli              |
| `ironclaw`    | `postgres://ironclaw`            | none           | `openai-compatible-proxy`                                               | experimental; requires PostgreSQL; requires systemd; routes Bedrock through bedrockify OpenAI-compatible backend |
| `nemoclaw`    | `~/.nemoclaw`, `docker:nemoclaw` | none           | `openai-compatible-proxy`                                               | experimental; requires nested Docker                                                                             |

`agents info <pack> --json` is the source of truth used by CLI tests for this metadata.
