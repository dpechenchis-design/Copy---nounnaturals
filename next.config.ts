import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // the dev badge sits on top of the sidebar and the phone bar, so it is off
  devIndicators: false,
  // Replit's editor shows the dev server through its own address (for example abc-00-xyz.picard.replit.dev)
  allowedDevOrigins: ["**.replit.dev"],
  // a week import sends the whole table to one server action; the 1 MB default is too small for a big import
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  // A private team tool: no page may be listed by a search engine. The header covers every route; the pages
  // also carry the robots meta tag (src/app/layout.tsx). There is no robots.txt block on purpose, so Google's
  // crawler and reviewers can fetch /privacy and /terms and see the noindex.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
