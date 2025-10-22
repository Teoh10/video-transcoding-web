// src/worker/transcodeWorker.js
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  videoRepo,
  getS3Client,
  getS3Bucket,
  buildRenditionKey,
  buildThumbnailKey,
} from "../lib/paths.js";
import {
  transcodeProfiles,
  extractThumbnail,
  ffprobeDurationSeconds,
} from "../lib/ffmpeg.js";
import { classifyImageAtPath } from "../lib/tagger.js";
import {
  receiveTranscodeMessages,
  deleteTranscodeMessage,
  extendTranscodeMessageVisibility,
  parseTranscodeJobBody,
} from "../lib/jobQueue.js";

const WORKER_ID = `${os.hostname()}-${process.pid}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const VISIBILITY_TIMEOUT_SECONDS = Number(
  process.env.SQS_VISIBILITY_TIMEOUT_SECONDS || 900
);
const VISIBILITY_HEARTBEAT_SECONDS = Number(
  process.env.SQS_VISIBILITY_HEARTBEAT_SECONDS ||
    Math.max(60, Math.floor(VISIBILITY_TIMEOUT_SECONDS / 2))
);
const WAIT_TIME_SECONDS = Number(process.env.SQS_WAIT_TIME_SECONDS || 20);

let shouldRun = false;
let current = null; // { userId, videoId, abortController }

function bucket() {
  return getS3Bucket();
}

async function downloadOriginal(video, destination) {
  const data = await getS3Client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: video.originalKey })
  );
  if (!data.Body) {
    throw new Error("Original object missing");
  }
  await pipeline(data.Body, fs.createWriteStream(destination));
}

async function uploadFileToS3(localPath, key, contentType) {
  const body = fs.createReadStream(localPath);
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  const stat = await fsp.stat(localPath);
  return stat.size;
}

async function processVideo(video) {
  const { userId, videoId } = video;
  const abortController = new AbortController();
  let tmpDir;

  try {
    current = { userId, videoId, abortController };

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cab432-"));
    const originalPath = path.join(tmpDir, "original.mp4");
    await downloadOriginal(video, originalPath);

    const duration = await ffprobeDurationSeconds(originalPath);

    const profiles = [
      { resolution: "1080", vf: "scale=-2:1080", crf: 22, ab: "128k", file: path.join(tmpDir, "1080.mp4") },
      { resolution: "720", vf: "scale=-2:720", crf: 23, ab: "128k", file: path.join(tmpDir, "720.mp4") },
      { resolution: "480", vf: "scale=-2:480", crf: 24, ab: "96k", file: path.join(tmpDir, "480.mp4") },
    ];

    await transcodeProfiles(
      originalPath,
      profiles.map((p) => ({ vf: p.vf, out: p.file, crf: p.crf, ab: p.ab })),
      { signal: abortController.signal }
    );

    const renditions = [];
    for (const profile of profiles) {
      const key = buildRenditionKey(userId, videoId, profile.resolution);
      const sizeBytes = await uploadFileToS3(profile.file, key, "video/mp4");
      renditions.push({
        resolution: profile.resolution,
        s3Key: key,
        sizeBytes,
      });
    }

    const thumbnailPath = path.join(tmpDir, "thumbnail.jpg");
    await extractThumbnail(originalPath, thumbnailPath, 3, {
      signal: abortController.signal,
    });
    const thumbnailKey = buildThumbnailKey(userId, videoId);
    await uploadFileToS3(thumbnailPath, thumbnailKey, "image/jpeg");

    let tags = [];
    try {
      tags = await classifyImageAtPath(thumbnailPath);
    } catch (tagErr) {
      console.warn("[worker] tagging failed", tagErr?.message || tagErr);
    }

    await videoRepo.markCompleted(userId, videoId, {
      duration,
      thumbnailKey,
      renditions,
      tags,
    });
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? "Canceled by user"
        : err?.message || "Transcode failed";
    console.error("[worker] transcode failed", userId, videoId, err);
    await videoRepo.markFailed(userId, videoId, message).catch(() => {});
    throw err;
  } finally {
    current = null;
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function startVisibilityExtender(receiptHandle) {
  if (!receiptHandle || VISIBILITY_HEARTBEAT_SECONDS <= 0) {
    return () => {};
  }
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    extendTranscodeMessageVisibility(
      receiptHandle,
      VISIBILITY_TIMEOUT_SECONDS
    ).catch((err) => {
      console.warn("[worker] failed to extend message visibility", err);
    });
  }, VISIBILITY_HEARTBEAT_SECONDS * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function handleMessage(message) {
  let job;
  try {
    job = parseTranscodeJobBody(message.Body);
  } catch (err) {
    console.warn("[worker] dropping malformed job payload", err);
    await deleteTranscodeMessage(message.ReceiptHandle);
    return;
  }

  const { userId, videoId } = job;
  let lockedVideo;
  try {
    lockedVideo = await videoRepo.markProcessing(userId, videoId, WORKER_ID);
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      console.warn(
        `[worker] job ${job.jobId} skipped (status no longer queued)`
      );
      await deleteTranscodeMessage(message.ReceiptHandle);
      return;
    }
    throw err;
  }

  if (!lockedVideo) {
    await deleteTranscodeMessage(message.ReceiptHandle);
    return;
  }

  const videoInput = {
    ...lockedVideo,
    originalKey: lockedVideo.originalKey || job.originalKey,
  };

  const stopExtender = startVisibilityExtender(message.ReceiptHandle);
  try {
    await processVideo(videoInput);
    await deleteTranscodeMessage(message.ReceiptHandle);
  } catch (err) {
    console.error(
      `[worker] job ${job.jobId} failed (message will be retried)`,
      err?.message || err
    );
    // Intentionally do not delete message so SQS can redrive or move to DLQ.
  } finally {
    stopExtender();
  }
}

async function pollQueue() {
  while (shouldRun) {
    try {
      const { messages } = await receiveTranscodeMessages({
        maxNumber: 1,
        waitSeconds: WAIT_TIME_SECONDS,
        visibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      });
      if (!messages.length) {
        continue;
      }
      for (const message of messages) {
        if (!shouldRun) break;
        await handleMessage(message);
      }
    } catch (err) {
      console.error("[worker] poll loop error", err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export async function startTranscodeWorker() {
  if (shouldRun) return;
  shouldRun = true;
  console.log(
    `[worker] ${WORKER_ID} starting (wait=${WAIT_TIME_SECONDS}s, visibility=${VISIBILITY_TIMEOUT_SECONDS}s)`
  );
  pollQueue().catch((err) => {
    console.error("[worker] poll loop crashed", err);
    process.exit(1);
  });
}

export function stopTranscodeWorker() {
  shouldRun = false;
}

export function getCurrentTranscodeId() {
  return current?.videoId ?? null;
}

export function cancelCurrentTranscode() {
  if (current?.abortController) {
    current.abortController.abort();
    return true;
  }
  return false;
}
