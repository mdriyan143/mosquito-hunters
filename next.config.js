/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['mongodb'] },
  // Bake the values from client/.env into the server build so the API routes
  // work on Vercel without setting anything in the Vercel dashboard.
  // (Only lib/db.js reads these, and it is server-only, so they never reach the browser.)
  env: {
    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB: process.env.MONGODB_DB || '',
  },
};
