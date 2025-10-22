import crypto from "node:crypto";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { getRegion, getS3Bucket } from "./paths.js";

function requireQueueUrl() {
  const url = process.env.SQS_QUEUE_URL;
  if (!url) {
    throw new Error("SQS_QUEUE_URL env var must be set");
  }
  return url;
}

let sqsClient;
export function getSqsClient() {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region: getRegion() });
  }
  return sqsClient;
}

export function getQueueUrl() {
  return requireQueueUrl();
}

function parseRenditionsEnv() {
  const raw = process.env.TRANSCODE_RENDITIONS;
  if (!raw) {
    return ["1080", "720", "480"];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const TRANSCODE_RENDITIONS = Object.freeze(parseRenditionsEnv());

export function buildJobPayload(video, overrides = {}) {
  const now = Date.now();
  const base = {
    v: 1,
    jobId: crypto.randomUUID(),
    videoId: video.videoId,
    bucket: getS3Bucket(),
    originalKey: video.originalKey,
    renditions: TRANSCODE_RENDITIONS,
    userId: video.userId,
    submittedAt: now,
  };
  return { ...base, ...overrides };
}

export async function enqueueTranscodeJob(video, overrides = {}) {
  const payload = buildJobPayload(video, overrides);
  const command = new SendMessageCommand({
    QueueUrl: getQueueUrl(),
    MessageBody: JSON.stringify(payload),
  });
  await getSqsClient().send(command);
  return payload;
}

export async function receiveTranscodeMessages(options = {}) {
  const {
    maxNumber = 1,
    waitSeconds = Number(process.env.SQS_WAIT_TIME_SECONDS || 20),
    visibilityTimeout = Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS || 900),
  } = options;
  const command = new ReceiveMessageCommand({
    QueueUrl: getQueueUrl(),
    MaxNumberOfMessages: maxNumber,
    WaitTimeSeconds: waitSeconds,
    VisibilityTimeout: visibilityTimeout,
  });
  const response = await getSqsClient().send(command);
  return {
    messages: response.Messages || [],
    visibilityTimeout,
  };
}

export async function deleteTranscodeMessage(receiptHandle) {
  if (!receiptHandle) return;
  const command = new DeleteMessageCommand({
    QueueUrl: getQueueUrl(),
    ReceiptHandle: receiptHandle,
  });
  await getSqsClient().send(command);
}

export async function extendTranscodeMessageVisibility(receiptHandle, timeoutSeconds) {
  if (!receiptHandle) return;
  const command = new ChangeMessageVisibilityCommand({
    QueueUrl: getQueueUrl(),
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: timeoutSeconds,
  });
  await getSqsClient().send(command);
}

export function parseTranscodeJobBody(body) {
  if (!body) throw new Error("Empty SQS message body");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err?.message || err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Malformed job payload");
  }
  if (parsed.v !== 1) {
    throw new Error(`Unsupported payload version: ${parsed.v}`);
  }
  const required = [
    "jobId",
    "videoId",
    "bucket",
    "originalKey",
    "renditions",
    "userId",
    "submittedAt",
  ];
  for (const key of required) {
    if (parsed[key] === undefined || parsed[key] === null) {
      throw new Error(`Missing required field '${key}' in job payload`);
    }
  }
  if (!Array.isArray(parsed.renditions) || !parsed.renditions.length) {
    throw new Error("Job payload renditions must be a non-empty array");
  }
  return parsed;
}
