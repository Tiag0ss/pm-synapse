/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // Keep Next from treating the parent monorepo as the workspace root
  outputFileTracingRoot: path.join(__dirname),
  transpilePackages: ['mermaid', '@mermaid-js/layout-elk', 'elkjs'],
};

module.exports = nextConfig;
