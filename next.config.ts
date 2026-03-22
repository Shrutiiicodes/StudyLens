import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['neo4j-driver', 'pdf-parse', 'mammoth'],
  turbopack: {},
};

export default nextConfig;
