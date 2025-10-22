// src/routes/videos.js
import { Router } from "express";
import crypto from "node:crypto";
import { body, query } from "express-validator";
import { authRequired, requireGroup } from "../middleware/auth.js";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  videoRepo,
  getS3Client,
  getS3Bucket,
  buildOriginalKey,
} from "../lib/paths.js";
import { createUploadUrl } from "../lib/s3Presign.js";
import { bumpNamespace, buildVideosListKey, cacheGetJSON, cacheSetJSON } from "../lib/cache.js";
import { enqueueTranscodeJob } from "../lib/jobQueue.js";
import { getCurrentTranscodeId, cancelCurrentTranscode } from "../worker/transcodeWorker.js";

function normalizeDuration(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function tagStrings(tags = []) {
  return tags
    .map((t) => {
      if (!t) return null;
      if (typeof t === "string") return t;
      if (typeof t.tag === "string") return t.tag;
      return null;
    })
    .filter(Boolean);
}

function buildVideoResponse(video) {
  if (!video) return null;
  return {
    id: video.videoId,
    userId: video.userId,
    title: video.title,
    status: video.status,
    duration: video.duration,
    originalKey: video.originalKey,
    thumbnailKey: video.thumbnailKey,
    renditions: video.renditions || [],
    tags: (video.tags || [])
      .map((t) => (typeof t === "string" ? t : t?.tag))
      .filter(Boolean),
    errorMessage: video.errorMessage,
    sourceType: video.sourceType,
    sourceUrl: video.sourceUrl,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
  };
}

export function videoRoutes() {
  const router = Router();

  // 🔹 Request a presigned upload URL
  router.post(
    "/videos/upload-url",
    authRequired,
    body("contentType").optional().isString(),
    async (req, res) => {
      try {
        const userId = req.user.sub;
        const videoId = crypto.randomUUID();
        const originalKey = buildOriginalKey(userId, videoId);
        const { url, expiresIn } = await createUploadUrl({
          key: originalKey,
          contentType: req.body?.contentType,
        });

        return res.json({
          videoId,
          uploadUrl: url,
          expiresIn,
          method: "PUT",
          originalKey,
        });
      } catch (err) {
        console.error("Failed to create upload URL", err);
        return res.status(500).json({ error: "Failed to create upload URL" });
      }
    }
  );

  // 🔹 Mark upload complete and register metadata
  router.post(
    "/videos/:id/complete",
    authRequired,
    body("title").optional().isString().trim().isLength({ min: 1 }),
    body("duration").optional().isNumeric(),
    async (req, res) => {
      const { id: videoId } = req.params;
      const userId = req.user.sub;
      const originalKey = buildOriginalKey(userId, videoId);

      try {
        await getS3Client().send(
          new HeadObjectCommand({ Bucket: getS3Bucket(), Key: originalKey })
        );
      } catch (err) {
        if (err?.name === "NotFound") {
          return res.status(404).json({ error: "Uploaded object not found" });
        }
        console.error("Failed to verify uploaded object", err);
        return res.status(500).json({ error: "Failed to verify uploaded object" });
      }

      try {
        const title = req.body?.title || "video";
        const duration = normalizeDuration(req.body?.duration);
        const created = await videoRepo.create({
          userId,
          videoId,
          title,
          originalKey,
          duration,
        });
        await bumpNamespace(userId); // 🔹 Invalidate cache
        try {
          await enqueueTranscodeJob(created);
        } catch (queueErr) {
          console.error("Failed to enqueue transcode job", queueErr);
          try {
            await videoRepo.markFailed(userId, videoId, "Queue publish failed");
          } catch (markErr) {
            console.error("Failed to mark video as failed after enqueue error", markErr);
          }
          return res.status(502).json({ error: "Failed to queue video for processing" });
        }
        return res.status(201).json({ video: buildVideoResponse(created) });
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return res.status(409).json({ error: "Video already exists" });
        }
        console.error("Failed to queue uploaded video", err);
        return res.status(500).json({ error: "Failed to queue uploaded video" });
      }
    }
  );

  // 🔹 List videos
  router.get(
    "/videos",
    authRequired,
    query("status").optional().isString(),
    query("q").optional().isString(),
    query("tag").optional().isString(),
    query("page").optional().isInt({ min: 1 }).toInt(),
    query("pageSize").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("per_page").optional().isInt({ min: 1, max: 100 }).toInt(),
    async (req, res) => {
      try {
        const statusFilter = req.query.status || "";
        const tagFilter = req.query.tag || "";
        const search = req.query.q?.toString().toLowerCase() || "";
        const sortParam = (req.query.sort || "-created_at").toString();
        const page = Number(req.query.page) || 1;
        const perPage = Number(req.query.per_page || req.query.pageSize) || 6;
        const limit = Math.min(Math.max(perPage, 1), 100);
        const offset = (page - 1) * limit;

        const key = await buildVideosListKey({
          sub: req.user.sub,
          page,
          perPage: limit,
          sort: `${sortParam}|s:${statusFilter}|t:${tagFilter}|q:${search}`.slice(0, 120),
        });

        const cached = await cacheGetJSON(key);
        if (cached) {
          const payloadString = JSON.stringify(cached);
          const etag = 'W/"vidlist-' + crypto.createHash("sha1").update(payloadString).digest("hex") + '"';
          if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
          }
          res.setHeader("ETag", etag);
          return res.json({ fromCache: true, ...cached });
        }

        let items;
        if (req.user.groups.includes("Admin")) {
          items = await videoRepo.listAll();
        } else {
          items = await videoRepo.listByUser(req.user.sub);
        }

        const filtered = items.filter((item) => {
          if (statusFilter && item.status !== statusFilter) return false;
          if (search) {
            const title = (item.title || "").toLowerCase();
            if (!title.includes(search)) return false;
          }
          if (tagFilter) {
            const tags = tagStrings(item.tags);
            if (!tags.includes(tagFilter)) return false;
          }
          return true;
        });

        const sortFieldRaw = sortParam.startsWith("-") ? sortParam.slice(1) : sortParam;
        const sortDir = sortParam.startsWith("-") ? -1 : 1;
        const sortFieldMap = { created_at: "createdAt", title: "title", status: "status" };
        const field = sortFieldMap[sortFieldRaw] || "createdAt";
        filtered.sort((a, b) => {
          const va = (a[field] || "").toString().toLowerCase();
          const vb = (b[field] || "").toString().toLowerCase();
          if (va < vb) return -1 * sortDir;
          if (va > vb) return 1 * sortDir;
          return 0;
        });

        const total = filtered.length;
        const paginated = filtered.slice(offset, offset + limit).map(buildVideoResponse);

        const totalPages = Math.max(1, Math.ceil(total / limit));
        const responsePayload = { page, pageSize: limit, total, totalPages, items: paginated };

        const payloadString = JSON.stringify(responsePayload);
        const etag = 'W/"vidlist-' + crypto.createHash("sha1").update(payloadString).digest("hex") + '"';
        if (req.headers["if-none-match"] === etag) {
          return res.status(304).end();
        }

        try {
          await cacheSetJSON(key, responsePayload, 30);
        } catch {}

        res.setHeader("ETag", etag);
        return res.json(responsePayload);
      } catch (err) {
        console.error("List videos failed", err);
        return res.status(500).json({ error: "Failed to list videos" });
      }
    }
  );

  // 🔹 Fetch single video
  router.get("/videos/:id", authRequired, async (req, res) => {
    try {
      let video;
      if (req.user.groups.includes("Admin")) {
        const all = await videoRepo.listAll();
        video = all.find((v) => v.videoId === req.params.id) || null;
      } else {
        video = await videoRepo.get(req.user.sub, req.params.id);
      }

      if (!video) return res.status(404).json({ error: "Not found" });

      const payload = buildVideoResponse(video);
      const etagSource = JSON.stringify(payload || {});
      const etag = `W/"vid-${video.videoId}-${crypto.createHash("sha1").update(etagSource).digest("hex")}"`;

      if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
      }

      res.set("ETag", etag);
      return res.json(payload);
    } catch (err) {
      console.error("Fetch video failed", err);
      return res.status(500).json({ error: "Failed to load video" });
    }
  });

  // 🔹 Cancel processing
  router.post("/videos/:id/cancel", authRequired, async (req, res) => {
    try {
      const userId = req.user.sub;
      const videoId = req.params.id;
      const video = await videoRepo.get(userId, videoId);
      if (!video) return res.status(404).json({ error: "Not found" });

      if (video.status === "queued") {
        await videoRepo.markCanceled(userId, videoId);
        return res.json({ canceled: true, status: "failed" });
      }

      if (video.status === "processing") {
        if (getCurrentTranscodeId() === videoId && cancelCurrentTranscode()) {
          return res.json({ canceling: true, status: "processing" });
        }
        return res.status(409).json({ error: "Worker is not on this video right now" });
      }

      return res.status(400).json({ error: `Cannot cancel in status ${video.status}` });
    } catch (err) {
      console.error("Cancel video failed", err);
      return res.status(500).json({ error: "Failed to cancel video" });
    }
  });

  // 🔹 Delete video (Admin only)
  router.delete("/videos/:id", authRequired, requireGroup("Admin"), async (req, res) => {
    const videoId = req.params.id;
    try {
      const allVideos = await videoRepo.listAll();
      const video = allVideos.find((v) => v.videoId === videoId);
      if (!video) return res.status(404).json({ error: "Not found" });

      if (video.status === "processing") {
        if (getCurrentTranscodeId() === videoId) cancelCurrentTranscode();
        await videoRepo.markFailed(video.userId, videoId, "deleted by admin");
      }

      const objects = [];
      if (video.originalKey) objects.push({ Key: video.originalKey });
      if (video.thumbnailKey) objects.push({ Key: video.thumbnailKey });
      for (const rendition of video.renditions || []) {
        if (rendition?.s3Key) objects.push({ Key: rendition.s3Key });
      }

      if (objects.length) {
        await getS3Client().send(
          new DeleteObjectsCommand({
            Bucket: getS3Bucket(),
            Delete: { Objects: objects, Quiet: true },
          })
        );
      }

      await videoRepo.remove(video.userId, videoId);
      await bumpNamespace(video.userId);
      return res.status(204).end();
    } catch (err) {
      console.error("Delete video failed", err);
      return res.status(500).json({ error: "Failed to delete video" });
    }
  });

  return router;
}
