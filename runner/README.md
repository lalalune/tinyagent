# TinyAgent Runner Image

This directory contains the deterministic runner image inputs for the first
TinyAgent dstack target.

- `Dockerfile` builds from a pinned Bun base tag and installs the runtime tools
  needed by TinyAgent, Lowkey packs, OpenClaw, and provider exec. The image
  pins Node.js `22.21.1` because current Lowkey/OpenClaw CLI dependencies
  require Node 22.19 or newer.
- `app-compose.json` is the canonical dstack app-compose manifest for the
  OpenClaw runner.
- `app-compose.sha256` is the expected compose hash for attestation policy
  checks.

Build from the `tinyagent/` workspace root:

```sh
docker build -f runner/Dockerfile -t tinyagent-runner:0.1.0-lowkey-5e18dac .
```

The image copies the pinned Lowkey checkout from `vendor/lowkey`; the vendor
marker records commit `5e18dac550f8cf0ac509e51679a6e41a6a90e528`.

The normal-container runner does not boot user `systemd`, so it includes a
small compatibility supervisor for the Lowkey OpenClaw user service path. The
`systemctl` and `loginctl` shims only implement the subset used by
`packs/openclaw/install.sh`; they start the generated `openclaw-gateway.service`
under a PID/log directory in `XDG_RUNTIME_DIR`.
