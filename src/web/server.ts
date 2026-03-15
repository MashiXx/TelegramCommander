import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { config } from "../config/config";
import apiRouter from "./api";

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const [user, pass] = decoded.split(":");
  if (user !== config.webUser || pass !== config.webPass) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  next();
}

export function startWebServer(): void {
  const app = express();

  app.use(express.json());

  // Static files served without auth (login page needs to load)
  app.use(express.static(path.join(__dirname, "public")));

  // API routes protected by basic auth
  if (config.webPass) {
    app.use("/api", basicAuth);
  }
  app.use("/api", apiRouter);

  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(config.webPort, () => {
    console.log(`[web] Admin panel running on http://localhost:${config.webPort}`);
  });
}
