# syntax=docker/dockerfile:1
# TinyAgent web console (apps/web). Self-contained — build from THIS directory:
#   docker build -t tinyagent-web apps/web
# Configure at run time (see apps/web/.env.example):
#   docker run -p 3000:3000 \
#     -e NEXT_PUBLIC_CONTROL_PLANE_URL=https://api.example.com \
#     -e NEXT_PUBLIC_MOCK=0 tinyagent-web
# Pin to a digest in production: node:20-slim@sha256:<digest>
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
USER node
CMD ["npm", "run", "start"]
