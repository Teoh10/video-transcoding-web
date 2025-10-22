// src/index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { videoRoutes } from "./routes/videos.js";
import { mediaRoutes } from "./routes/media.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectToMemcached } from "./lib/cache.js";
// 🔐 Config loaders
import { ensureParametersLoaded } from "./config/parameterStore.js";
import { loadSecrets } from "./config/secretManager.js";

const app = express();

const bootstrap = async () => {
  // 1. Load secrets first (sensitive values)
  await loadSecrets();
  console.log("✅ Secrets loaded from AWS Secrets Manager");

  // 2. Load parameter store values (non-sensitive configs)
  await ensureParametersLoaded([
    "AWS_REGION",
    "PORT",
    "JWT_EXPIRES",
    "HF_IMAGE_MODEL",
    "TAGS_TOP_K",
    "TAGS_MIN_SCORE",
    "QUT_USERNAME",
    "TRANSCODE_LOCK_TTL_MS",
    "SQS_QUEUE_URL"
  ]);
  console.log("✅ Parameters loaded from AWS SSM Parameter Store");

  // Now safe to use env vars
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
  const PORT = process.env.PORT || 8000;
  const HOST = process.env.HOST || "0.0.0.0"; // bind to all interfaces for Docker/EC2
  // Connect & self-test Memcached (non-blocking)
  try {
    const m = connectToMemcached();
    const testKey = 'selftest:' + Date.now();
    m.set(testKey, '1', 5, (err) => {
      if (err) return console.warn('[cache] self-test set failed -> using fallback?', err.message || err);
      m.get(testKey, (gErr, val) => {
        if (gErr) console.warn('[cache] self-test get failed', gErr.message || gErr);
        else console.log('[cache] self-test OK (memcached reachable), value=', val);
      });
    });
  } catch (e) {
    console.warn('[cache] memcached connect threw error -> fallback', e.message || e);
  }
  app.use(cors({ origin: CORS_ORIGIN === "*" ? undefined : CORS_ORIGIN }));
  app.use(morgan("dev"));
  app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || "10mb" }));

  // ===== DEBUG TEMP (thumbnail trace) BEGIN =====
  app.use((req, _res, next) => {
    if (req.url.includes('/videos') && req.url.includes('/thumb')) {
      console.log('[DBG thumb] incoming', req.method, req.url, 'auth hdr?', !!req.headers.authorization);
    }
    next();
  });
  // ===== DEBUG TEMP (thumbnail trace) END =====

  // Health check
  app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

  // Static frontend
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  app.use("/", express.static(path.join(__dirname, "..", "public")));
  app.get("/login", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  });

  // API routes
  app.use("/api/v1/auth", authRoutes());
  app.use("/api/v1", meRoutes());
  app.use("/api/v1", videoRoutes());
  app.use("/api/v1", mediaRoutes());

  // Start server
  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Server listening on http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
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
  console.error("❌ Failed to start server", e);
  process.exit(1);
});
