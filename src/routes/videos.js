import { Router } from "express";
import crypto from "node:crypto";
import { body, query, validationResult } from "express-validator";
import { authRequired, requireGroup } from "../middleware/auth.js"; // ✅ import requireGroup
import { upload } from "../lib/upload.js";
import {
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  videoRepo,
  s3Client,
  S3_BUCKET,
  buildOriginalKey,
} from "../lib/paths.js";
import {
  notifyTranscodeWorker,
  getCurrentTranscodeId,
  cancelCurrentTranscode,
} from "../worker/transcodeWorker.js";
import { createUploadUrl } from "../lib/s3Presign.js";
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

  // 🔹 Upload video — any authenticated user
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
        await s3Client.send(
          new HeadObjectCommand({ Bucket: S3_BUCKET, Key: originalKey })
        );
      } catch (err) {
        if (err?.name === "NotFound") {
          return res.status(404).json({ error: "Uploaded object not found" });
        }
        console.error("Failed to verify uploaded object", err);
        return res
          .status(500)
          .json({ error: "Failed to verify uploaded object" });
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

        notifyTranscodeWorker();
        return res.status(201).json({ video: buildVideoResponse(created) });
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          return res.status(409).json({ error: "Video already exists" });
        }
        console.error("Failed to queue uploaded video", err);
        return res
          .status(500)
          .json({ error: "Failed to queue uploaded video" });
      }
    }
  );

  router.post(
    "/videos",
    authRequired,
    upload.single("file"),
    body("title").optional().isString().trim().isLength({ min: 1 }),
    body("duration").optional().isNumeric(),
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Provide a video file upload" });
      }
      if (req.file.mimetype !== "video/mp4") {
        return res
          .status(400)
          .json({ error: "Only video/mp4 uploads are supported" });
      }

      const userId = req.user.sub; // 🔹 use Cognito sub as unique userId
      const videoId = crypto.randomUUID();
      const title = req.body.title || req.file.originalname || "video";
      const duration = normalizeDuration(req.body.duration);
      const originalKey = buildOriginalKey(userId, videoId);

      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: originalKey,
            Body: req.file.buffer,
            ContentType: "video/mp4",
          })
        );

        const created = await videoRepo.create({
          userId,
          videoId,
          title,
          originalKey,
          duration,
        });

        notifyTranscodeWorker();

        return res.status(201).json({
          video: buildVideoResponse(created),
        });
      } catch (err) {
        console.error("Video upload failed", err);
        return res.status(500).json({ error: "Failed to store video" });
      }
    }
  );

  // 🔹 List videos — any authenticated user
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
        const statusFilter = req.query.status;
        const tagFilter = req.query.tag;
        const search = req.query.q?.toString().toLowerCase();
        const page = req.query.page || 1;
        const perPage = req.query.per_page || req.query.pageSize || 10;
        const limit = Math.min(Math.max(perPage, 1), 100);
        const offset = (page - 1) * limit;
        // 🔹 Build a cache key (per user + filters)
        const key = await buildVideosListKey({
          sub: req.user.sub,
          page,
          perPage: limit,
          sort: "default", // you can expand later if you support sorting
        });

        // 🔹 Try cache
        const cached = await cacheGetJSON(key);
        if (cached) {
          console.log("CACHE_HIT", key);
          return res.json({ fromCache: true, ...cached });
        }
        console.log("CACHE_MISS", key);
        let items;
        if (req.user.groups.includes("Admin")) {
          // ✅ Admin sees all videos
          items = await videoRepo.listAll();
        } else {
          // ✅ Normal users only see their own
          items = await videoRepo.listByUser(req.user.sub);
        }

        const filtered = items.filter((item) => {
          if (statusFilter && item.status !== statusFilter) return false;
          if (
            search &&
            item.title &&
            !item.title.toLowerCase().includes(search)
          )
            return false;
          if (tagFilter) {
            const tags = tagStrings(item.tags);
            if (!tags.includes(tagFilter)) return false;
          }
          return true;
        });

        const total = filtered.length;
        const paginated = filtered
          .slice(offset, offset + limit)
          .map(buildVideoResponse);

        return res.json({
          page,
          pageSize: limit,
          total,
          items: paginated,
        });
      } catch (err) {
        console.error("List videos failed", err);
        return res.status(500).json({ error: "Failed to list videos" });
      }
    }
  );

  // 🔹 Fetch single video — any authenticated user
  router.get("/videos/:id", authRequired, async (req, res) => {
    try {
      let video;
      if (req.user.groups.includes("Admin")) {
        // Admin can see any user’s video
        const all = await videoRepo.listAll();
        video = all.find((v) => v.videoId === req.params.id) || null;
      } else {
        // Normal user only sees their own
        video = await videoRepo.get(req.user.sub, req.params.id);
      }

      if (!video) {
        return res.status(404).json({ error: "Not found" });
      }

      const payload = buildVideoResponse(video);
      const etagSource = JSON.stringify(payload || {});
      const etag = `W/"vid-${video.videoId}-${crypto
        .createHash("sha1")
        .update(etagSource)
        .digest("hex")}"`;

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

  // 🔹 Cancel processing — any authenticated user (their own video)
  router.post("/videos/:id/cancel", authRequired, async (req, res) => {
    try {
      const userId = req.user.sub;
      const videoId = req.params.id;
      const video = await videoRepo.get(userId, videoId);
      if (!video) {
        return res.status(404).json({ error: "Not found" });
      }

      if (video.status === "queued") {
        await videoRepo.markCanceled(userId, videoId);
        return res.json({ canceled: true, status: "failed" });
      }

      if (video.status === "processing") {
        if (getCurrentTranscodeId() === videoId && cancelCurrentTranscode()) {
          return res.json({ canceling: true, status: "processing" });
        }
        return res
          .status(409)
          .json({ error: "Worker is not on this video right now" });
      }

      return res
        .status(400)
        .json({ error: `Cannot cancel in status ${video.status}` });
    } catch (err) {
      console.error("Cancel video failed", err);
      return res.status(500).json({ error: "Failed to cancel video" });
    }
  });

  // 🔹 Delete video — only Admin group members
  router.delete(
    "/videos/:id",
    authRequired,
    requireGroup("Admin"),
    async (req, res) => {
      const videoId = req.params.id;

      try {
        let video;

        // Admins can see all videos
        const allVideos = await videoRepo.listAll();
        video = allVideos.find((v) => v.videoId === videoId);

        if (!video) {
          return res.status(404).json({ error: "Not found" });
        }

        // If the video is still processing, cancel/mark as failed
        if (video.status === "processing") {
          if (getCurrentTranscodeId() === videoId) {
            cancelCurrentTranscode();
          }
          await videoRepo.markFailed(video.userId, videoId, "deleted by admin");
        }

        // Collect S3 objects to delete
        const objects = [];
        if (video.originalKey) objects.push({ Key: video.originalKey });
        if (video.thumbnailKey) objects.push({ Key: video.thumbnailKey });
        for (const rendition of video.renditions || []) {
          if (rendition?.s3Key) objects.push({ Key: rendition.s3Key });
        }

        if (objects.length) {
          await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: S3_BUCKET,
              Delete: { Objects: objects, Quiet: true },
            })
          );
        }

        // Remove DynamoDB record using the actual video.userId
        await videoRepo.remove(video.userId, videoId);

        return res.status(204).end();
      } catch (err) {
        console.error("Delete video failed", err);
        return res.status(500).json({ error: "Failed to delete video" });
      }
    }
  );

  return router;
}
