import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

// `pnpm dev:backend` serves the API; override to point at another instance.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://localhost:9000";

/*
 * One static site: Starlight serves the docs under `/docs`, and the app is a page of the same site at `/`.
 */
export default defineConfig({
  outDir: "./build",
  // Avoids a native image dependency.
  image: { service: passthroughImageService() },
  integrations: [
    react(),
    starlight({
      title: "GitHub Reactions Notifier",
      description:
        "Get notified about reactions to your GitHub issues, pull requests and comments.",
      sidebar: [{ label: "Overview", slug: "docs" }],
    }),
  ],
  vite: {
    /*
     * In the Docker image the backend serves both `/api` and the built site.
     * Locally the two are separate servers, so forward `/api` to `pnpm dev:backend`.
     */
    server: { proxy: { "/api": BACKEND_ORIGIN } },
    resolve: {
      conditions: ["@grn/source"],
    },
  },
});
