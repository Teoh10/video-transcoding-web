import { loadSecrets } from "../config/secretManager.js";
import { ensureParametersLoaded } from "../config/parameterStore.js";

const REQUIRED_PARAMETERS = [
  "AWS_REGION",
  "QUT_USERNAME",
  "S3_BUCKET",
  "DDB_TABLE",
  "TRANSCODE_LOCK_TTL_MS",
  "SQS_QUEUE_URL"
];

async function bootstrap() {
  try {
    await loadSecrets();
    await ensureParametersLoaded(REQUIRED_PARAMETERS);

    const { startTranscodeWorker } = await import("./transcodeWorker.js");
    startTranscodeWorker();

    const handleExit = (signal) => {
      console.log(`[worker-service] received ${signal}, exiting`);
      process.exit(0);
    };

    process.on("SIGTERM", () => handleExit("SIGTERM"));
    process.on("SIGINT", () => handleExit("SIGINT"));

    console.log("[worker-service] transcode worker started");
  } catch (err) {
    console.error("[worker-service] failed to start", err);
    process.exit(1);
  }
}

bootstrap();
