import fs from "fs/promises";
import { cacheRememberJson } from "./cache.js";
import { ensureParametersLoaded } from "../config/parameterStore.js";

let cachedConfig = null;

async function getTaggerConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  await ensureParametersLoaded(["HF_IMAGE_MODEL", "TAGS_TOP_K", "TAGS_MIN_SCORE"]);

  const token = process.env.HF_API_TOKEN;
  const model = process.env.HF_IMAGE_MODEL || "microsoft/resnet-50";
  const topK = Number(process.env.TAGS_TOP_K ?? 5);
  const minScore = Number(process.env.TAGS_MIN_SCORE ?? 0);

  cachedConfig = { token, model, topK, minScore };
  return cachedConfig;
}

export async function classifyImageAtPath(imagePath, { cacheKey } = {}) {
  const loadTags = async () => {
    const { token, model, topK, minScore } = await getTaggerConfig();
    if (!token) return [];
    const bytes = await fs.readFile(imagePath);

    const res = await fetch(
      `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Accept": "application/json",
          "x-wait-for-model": "true"
        },
        body: bytes
      }
    );

    if (!res.ok) {
      throw new Error(`[tagger] HF error ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .slice(0, topK)
      .map((entry) => ({
        tag: entry?.label,
        score: typeof entry?.score === "number" ? entry.score : undefined
      }))
      .filter((entry) => entry.tag && (entry.score === undefined || entry.score >= minScore));
  };

  if (!cacheKey) {
    return loadTags();
  }

  return cacheRememberJson(cacheKey, process.env.VIDEO_TAG_CACHE_TTL_SECONDS, loadTags);
}
