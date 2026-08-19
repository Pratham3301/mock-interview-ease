import type { NextConfig } from "next";

const fallbackSttMode = process.env.NEXT_PUBLIC_FALLBACK_STT_MODE;

const nextConfig: NextConfig = {
  /* config options here */
  // images: {
  //   remotePatterns: [
  //     {
  //       protocol: "https",
  //       hostname: "ik.imagekit.io",
  //       port: "",
  //     },
  //   ],
  // },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Explicitly inject this public build-time preference. Turbopack otherwise
  // leaves the shared voice module reading an empty browser process.env shim.
  env: {
    NEXT_PUBLIC_FALLBACK_STT_MODE:
      fallbackSttMode === "browser" || fallbackSttMode === "local"
        ? fallbackSttMode
        : "auto",
  },
};

export default nextConfig;
