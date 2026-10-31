import type { Request, Response } from "express";

import { default as cron } from "./api/cron.ts";
import { default as deleteAccount } from "./api/delete-account.ts";
import { default as login } from "./api/login.ts";
import { default as oauthCallback } from "./api/oauth/callback.ts";
import { default as statusUp } from "./api/status/up.ts";

export default async (req: Request, res: Response): Promise<void> => {
  const url = new URL(req.url, "https://localhost");

  switch (url.pathname) {
    case "/api/login":
      await login(req, res);
      break;
    case "/api/delete-account":
      await deleteAccount(req, res);
      break;
    case "/api/oauth/callback":
      await oauthCallback(req, res);
      break;
    case "/api/status/up":
      await statusUp(req, res);
      break;
    case "/api/cron":
      await cron(req, res);
      break;
    default:
      res.statusCode = 404;
      res.end("Not Found");
      break;
  }
};
