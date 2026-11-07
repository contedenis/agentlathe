import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentlathe/db", "@agentlathe/runner"],
  output: "standalone",
  // Monorepo: the standalone output must trace from the workspace root.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  experimental: { proxyClientMaxBodySize: "25mb" },
};

export default nextConfig;
