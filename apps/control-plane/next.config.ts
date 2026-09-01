import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ADR 0010 keeps the packages in source form in the workspace; Next compiles
  // them from `dist` like any other dependency, so nothing is transpiled here.
};

export default nextConfig;
