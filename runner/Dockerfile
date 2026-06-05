# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-debian AS tinyagent-runner

LABEL org.opencontainers.image.title="TinyAgent Lowkey Runner"
LABEL org.opencontainers.image.source="https://github.com/TinyCloudLabs/tinyagent"
LABEL tinyagent.lowkey.ref="inceptionstack/lowkey@5e18dac550f8cf0ac509e51679a6e41a6a90e528"

ENV NODE_ENV=production
ENV TINYAGENT_HOME=/opt/tinyagent
ENV LOWKEY_HOME=/opt/lowkey
ENV GATEWAY_PORT=3001
ENV NODE_VERSION=22.21.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gettext-base \
    git \
    jq \
    openssh-client \
    procps \
    python3 \
    tini \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
    amd64) node_arch="x64" ;; \
    arm64) node_arch="arm64" ;; \
    *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
  tar -xJf "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local --strip-components=1; \
  rm "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
  node --version; \
  npm --version

WORKDIR /opt/tinyagent

COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY vendor/lowkey /opt/lowkey
COPY runner/entrypoint.sh /usr/local/bin/tinyagent-runner
COPY runner/systemctl-shim.sh /usr/local/bin/systemctl
COPY runner/loginctl-shim.sh /usr/local/bin/loginctl

RUN chmod 0755 /usr/local/bin/tinyagent-runner /usr/local/bin/systemctl /usr/local/bin/loginctl
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:packages
RUN test -x /opt/lowkey/packs/openclaw/install.sh \
  && test -f /opt/lowkey/packs/openclaw/manifest.yaml \
  && test -f /opt/lowkey/deploy/brain/AGENTS.md

VOLUME ["/data"]
EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tinyagent-runner"]
