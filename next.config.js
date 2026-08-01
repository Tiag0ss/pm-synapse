/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // Keep Next from treating the parent monorepo as the workspace root
  outputFileTracingRoot: path.join(__dirname),
};

module.exports = nextConfig;
