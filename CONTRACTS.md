# TinyAgent Contracts

These contracts are the boundary between packages. Implementations may add fields internally, but persisted formats and provider boundaries must remain compatible with these schemas.

## Provider

`ComputeProvider` exposes sandbox lifecycle, exec, file transfer, port forwarding, and optional attestation.

Required methods:

- `provision(spec)`
- `start(sandbox)`
- `stop(sandbox)`
- `destroy(sandbox)`
- `exec(sandbox, command)`
- `putFiles(sandbox, files)`
- `getFiles(sandbox, paths)`
- `forwardPort(sandbox, remotePort, localPort)`
- `attest(sandbox, nonce)`

Local providers return `null` from `attest`.

`SandboxSpec` required fields:

- `name`
- `provider`
- `agent`
- `image`

`Sandbox` required fields:

- `id`
- `name`
- `provider`
- `status`

`AttestationDoc` required fields:

- `provider`
- `quote`
- `composeHash`
- `timestamp`

## Backup KV Layout

```text
tinyagent/<agent>/chunks/<blake3>
tinyagent/<agent>/snapshots/<timestamp>.manifest
tinyagent/<agent>/latest
tinyagent/<agent>/meta.json
```

Commit order is chunks, manifest, then `latest`.

## Backup Manifest

Required fields:

- `version`
- `agent`
- `pack`
- `timestamp`
- `stateDir`
- `chunks`
- `sealedContentKey`
- `backupPublicKeyId`
- `integrity`
- `runnerImageDigest`

Each chunk has `hash`, `length`, and `nonce`.

## Crypto Envelope

The wallet signs:

```text
tinyagent-backup-v1:<spaceId>
```

HKDF-SHA256 derives the X25519 backup keypair from that signature. The agent receives only the public key. Snapshot content keys are sealed to that public key.

## Store

Backup code depends on:

- `put(key, value, options?)`
- `get(key)`
- `head(key)`
- `list(prefix)`
- optional `delete(key)`

Values are byte arrays. Implementations must not log keys, tokens, or plaintext secrets.

## backupd Control API

Commands:

- `backupNow`
- `status`
- `prepareRestore`
- `renewDelegation`

The API binds to loopback and is reachable only through a provider tunnel.

## AgentSpec

Normalized lowkey pack metadata includes name, dependencies, ports, state paths, model modes, secret targets, and caveats.

Required fields:

- `name`
