import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/app/i18n/request.ts');

/** The browser only ever talks to the web origin; `/api/*` is proxied to the NestJS api (same origin = cookies just work). */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  outputFileTracingRoot: path.join(here, '../../'),
  poweredByHeader: false,
  // the repo runs one ESLint (root config, incl. FSD import rules) in CI; Next's own pass would use a different config
  eslint: { ignoreDuringBuilds: true },
  // gzip would buffer the SSE stream (/api/events) until the connection closes
  compress: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withNextIntl(config);
