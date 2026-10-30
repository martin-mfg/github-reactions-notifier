import type { Request, Response } from "express";

import { default as statusUp } from "./api/status/up.ts";

export default async (req: Request, res: Response): Promise<void> => {
  const url = new URL(req.url, "https://localhost");

  switch (url.pathname) {
    case "/api/status/up":
      await statusUp(req, res);
      break;
    default:
      res.statusCode = 404;
      res.end("Not Found");
      break;
  }
};
