import path from "node:path";

import express, { static as serveStatic } from "express";

import router from "./router.ts";

export const app = express();

app.use(
  serveStatic(path.join(import.meta.dirname, "../frontend/build"), {
    maxAge: 3600000,
  }),
);

app.use((req, res) => {
  // drop trailing slash
  const [pathname, query] = req.url.split("?", 2);
  if (pathname !== "/" && pathname?.endsWith("/")) {
    req.url = pathname.slice(0, -1) + (query === undefined ? "" : `?${query}`);
  }
  return router(req, res);
});
