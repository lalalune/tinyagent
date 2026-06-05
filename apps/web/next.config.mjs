/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app is a standalone island inside a monorepo. Pin the file-tracing root
  // to this directory so `next build` never tries to walk up into the repo-root
  // bun.lock / packages workspace when inferring the project root.
  experimental: {
    outputFileTracingRoot: import.meta.dirname,
  },
  // wagmi/viem pull in optional WalletConnect peer deps (pino, etc.) that we do
  // not use. Silence the resolver warnings for a clean build.
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
