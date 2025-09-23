import express from "express";
import cors from "cors";
import morgan from "morgan";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { videoRoutes } from "./routes/videos.js";
import { startTranscodeWorker } from "./worker/transcodeWorker.js";
import { mediaRoutes } from "./routes/media.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureParametersLoaded } from "./config/parameterStore.js";
import { connectToMemcached } from "./lib/cache.js";
const app = express();

const bootstrap = async () => {
  await ensureParametersLoaded([
    "AWS_REGION",
    "PORT",
    "JWT_EXPIRES",
    "HF_IMAGE_MODEL",
    "TAGS_TOP_K",
    "TAGS_MIN_SCORE",
    "QUT_USERNAME",
    "TRANSCODE_LOCK_TTL_MS"
  ]);
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
  const PORT = process.env.PORT || 8000;
  const HOST = process.env.HOST || "0.0.0.0"; // bind to all interfaces for Docker/EC2

  connectToMemcached();
  app.use(cors({ origin: CORS_ORIGIN === "*" ? undefined : CORS_ORIGIN }));
  app.use(morgan("dev"));
  app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || "10mb" }));

  app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  app.use("/", express.static(path.join(__dirname, "..", "public")));
  app.get("/login", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  });

  app.use("/api/v1/auth", authRoutes());
  app.use("/api/v1", meRoutes());
  app.use("/api/v1", videoRoutes());
  app.use("/api/v1", mediaRoutes());

  startTranscodeWorker();

  const server = app.listen(PORT, HOST, () => {
    console.log(`Auth API listening on http://${HOST}:${PORT}`);
  });

  const shutdown = async (sig) => {
    try {
      console.log(`\nReceived ${sig}, shutting down...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

bootstrap().catch((e) => {
  console.error("Failed to start server", e);
  process.exit(1);
});
