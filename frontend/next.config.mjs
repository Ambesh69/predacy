/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Proxy PostHog ingestion through Vercel so ad blockers (Brave, uBlock, etc.)
  // can't block requests to us.i.posthog.com. Events go to /ingest/... on our
  // own domain, which Vercel rewrites to PostHog's servers.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
};

export default nextConfig;
