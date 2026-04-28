const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Garante que o output file tracing inclua pacotes do monorepo (packages/shared)
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../../'),
  },

  webpack(config) {
    // Garante que o alias @ resolva corretamente mesmo quando o CWD
    // nao e apps/web (ex: build na raiz do monorepo via Vercel)
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.join(__dirname, 'src'),
    };
    return config;
  },

  async redirects() {
    return [
      {
        source: '/',
        destination: '/admin',
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
