# CAB432 Video Transcoding PlatformTo test run in local(fastest way), run:

docker compose up --build

A cloud-native video processing application built with Node.js, Express, and AWS services. Users can upload videos, which are automatically transcoded into multiple resolutions, thumbnailed, and auto-tagged using machine learning. The platform supports authentication, multi-user access, admin controls, and stateless horizontal scaling.Need to do "aws configure sso" to able to sign in to s3



## 🎯 Project Goals



- **Scalable video processing**: Handle uploads, transcode to multiple resolutions (1080p, 720p, 480p), and generate thumbnails using FFmpeg.1. docker

- **Cloud-native architecture**: Leverage AWS services (Cognito, S3, DynamoDB, Secrets Manager, Parameter Store, ElastiCache) for authentication, storage, metadata, configuration, and caching.AWS_REGION=ap-southeast-2

- **Stateless design**: All persistent state lives in AWS; the application can be restarted or scaled horizontally without data loss.AWS_ACCOUNT_ID=901444280953

- **Auto-tagging**: Classify video thumbnails using the Hugging Face Inference API to enable tag-based filtering.REPO=g57-a2

- **Role-based access**: Regular users manage their own videos; admins can delete any video.TAG=v8

ECR_URI=901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2

## ✨ Features

aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com

### Core Functionalitydocker build -t ${REPO}:${TAG} .

- **User Authentication** (AWS Cognito)docker tag ${REPO}:${TAG} ${ECR_URI}:${TAG}

  - Registration with email confirmationdocker push ${ECR_URI}:${TAG}

  - Login with username/password

  - JWT-based stateless authentication2. deploy

  - Group-based authorization (Admin group)aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com

docker pull ${ECR_URI}:${TAG}

- **Video Upload & Management**docker run -d   --name g57-a2   --restart unless-stopped   -p 80:8000   --env-file .env   ${ECR_URI}:${TAG}

  - Direct upload via multipart form-data

  - Presigned S3 URL upload (client → S3)

  - Video listing with pagination, search, status/tag filtering3. to test.

  - Single video retrieval with ETag cachingfor the caching, run :

  - Cancel in-progress transcodesmemcflush --server="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"

  - Admin-only video deletionmemcdump --servers="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"



- **Automated Transcoding Pipeline**it shows something that mean it is the cache

  - Background worker polls DynamoDB for queued jobsthumb:user/.../videos/.../thumbnail.jpg:v0

  - Transcodes to 1080p, 720p, 480p using FFmpeg👉 These are binary thumbnail images cached from S3 (JPEGs).

  - Generates thumbnail at 3s markvideos:list:c93eb4a8-5091-7039-cb90-5408488a9de5:v1:p3:n6:s-created_at|s:|t:|q:

  - Auto-tags thumbnail via Hugging Face image classification👉 This is the video list metadata cache entry.

  - Updates DynamoDB with renditions, thumbnail, duration, and tags

  - Handles failures and cancellations gracefully

for s3 just open the aws and show the s3 bucket name and video files

- **Media Delivery**for dynamo. open the dynamo table and show some table items

  - Presigned S3 URLs for streaming and downloading

  - Resolution selection (original, 1080p, 720p, 480p)dns just open the url just the dns name

  - Thumbnail serving with fallback SVG placeholder



- **Caching** (AWS ElastiCache / Memcached)

  - Namespace-based cache invalidation for video listsTerraform

  - Automatic cache warming on queries

  - Graceful degradation if cache is unavailable1) Go to this link to download https://developer.hashicorp.com/terraform/install

2) Create a folder called terraform, add three files, main.tf, output.tf and version.tf

### Cloud Services Integration3) run the code below to create 

- **AWS Cognito**: User pool for authentication, JWT verification

- **Amazon S3**: Object storage for video files, renditions, thumbnails (private bucket, presigned URLs only)##### Must cd into terraform folder first

- **Amazon DynamoDB**: NoSQL database for video metadata, job queue, worker locksterraform init

- **AWS Secrets Manager**: Stores sensitive credentials (e.g., Cognito client secret, HF API token)terraform fmt

- **AWS Systems Manager Parameter Store**: Non-sensitive config (region, app settings, tagging parameters)terraform validate

- **AWS ElastiCache (Memcached)**: In-memory cache for video list queriesterraform plan -out tfplan

- **Hugging Face Inference API**: Image classification for auto-tagging thumbnailsterraform apply tfplan



## 🏗️ Architectureterraform destroy # if want



See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed system design, data flows, and cloud integration patterns.



## 📚 API Reference



See [API_REFERENCE.md](./API_REFERENCE.md) for complete endpoint documentation with request/response schemas.#####################

AWS_REGION: used so the app knows which AWS region to talk to.

## 🚀 Quick Start

PORT: tells the Express server which port to listen on.

### Prerequisites

JWT_EXPIRES: sets how long login tokens remain valid.

**Local Development**

- Node.js 20 LTSHF_IMAGE_MODEL: stores which HuggingFace image model to call for video topic detection.

- FFmpeg installed and on PATH

- AWS CLI configured with `CAB432-STUDENT-901444280953` profileTAGS_TOP_K / TAGS_MIN_SCORE: configure filtering thresholds for auto-generated tags.

- AWS account access (Cognito, S3, DynamoDB, Secrets Manager, SSM, ElastiCache)

QUT_USERNAME: identifies the student for marking.

**Docker Development**

- Docker DesktopTRANSCODE_LOCK_TTL_MS: timeout for distributed locking of video transcoding jobs.
- AWS CLI configured

### Environment Variables

Create a `.env` file (not committed to git):

```bash
# Optional: override defaults
PORT=8000
AWS_REGION=ap-southeast-2
CORS_ORIGIN=*

# Local Memcached for docker-compose
MEMCACHED_ENDPOINT=memcached:11211

# Production (EC2)
# MEMCACHED_ENDPOINT=<your-elasticache-endpoint>:11211
```

**Note**: Sensitive values (Cognito secrets, HF token) are loaded from AWS Secrets Manager at runtime. Non-sensitive config (region, model name) comes from Parameter Store.

### Run Locally (Node.js)

```bash
# Install dependencies
npm ci

# Ensure AWS credentials are configured
aws configure list-profiles  # Should show CAB432-STUDENT-901444280953

# Start server
npm run dev
```

Open http://localhost:8000

### Run with Docker Compose

```bash
# Build and start (includes Memcached)
docker-compose up --build

# Or run detached
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop
docker-compose down
```

The compose file:
- Builds the Dockerfile
- Mounts `~/.aws` for AWS credentials (read-only)
- Starts a local Memcached container
- Exposes port 8000

### Deploy to AWS EC2

1. **Build and push to ECR**
```bash
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com

docker build -t cab432-app:latest .
docker tag cab432-app:latest <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/cab432-app:latest
docker push <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/cab432-app:latest
```

2. **Launch EC2 instance** (Amazon Linux 2023 or Ubuntu 22.04)
   - Attach IAM role with policies:
     - `AmazonEC2ContainerRegistryReadOnly`
     - `AmazonS3FullAccess` (or scoped to your bucket)
     - `AmazonDynamoDBFullAccess` (or scoped to your table)
     - `SecretsManagerReadWrite` (or read-only for your secret)
     - `AmazonSSMReadOnlyAccess` (or scoped to your parameter prefix)
     - ElastiCache access (if using managed Memcached)
   - Security group: allow inbound 8000 (HTTP), 22 (SSH)
   - VPC/subnet with internet access

3. **Install Docker on EC2**
```bash
# Amazon Linux 2023
sudo yum install -y docker
sudo systemctl enable docker --now
sudo usermod -aG docker ec2-user

# Ubuntu 22.04
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable docker --now
sudo usermod -aG docker ubuntu
```

4. **Pull and run container**
```bash
# Login to ECR
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com

# Pull image
docker pull <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/cab432-app:latest

# Run (set environment variables for production)
docker run -d \
  --name cab432-app \
  -p 8000:8000 \
  -e AWS_REGION=ap-southeast-2 \
  -e S3_BUCKET=<your-s3-bucket> \
  -e DDB_TABLE=<your-dynamodb-table> \
  -e QUT_USERNAME=<your-qut-username> \
  -e COGNITO_USER_POOL_ID=<your-pool-id> \
  -e COGNITO_CLIENT_ID=<your-client-id> \
  -e COGNITO_REGION=ap-southeast-2 \
  -e MEMCACHED_ENDPOINT=<your-elasticache-endpoint>:11211 \
  -e USE_PARAMETER_STORE=true \
  -e PARAMETER_STORE_PREFIX=/cab432/g57/app/ \
  --restart unless-stopped \
  <aws-account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/cab432-app:latest
```

5. **Configure Route53**
   - Create a CNAME record (e.g., `g57.cab432.com`) pointing to your EC2 public DNS
   - For HTTPS (Assessment 3), update the CNAME to point to a load balancer or CloudFront distribution with TLS

### Verify Deployment

```bash
# Health check
curl http://<ec2-public-ip>:8000/api/v1/health

# Should return: {"ok":true}
```

## 🧪 Testing

### Manual Testing

1. **Register a user**
```bash
curl -X POST http://localhost:8000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"Test1234!","email":"test@example.com"}'
```

2. **Confirm email** (check your email for the code)
```bash
curl -X POST http://localhost:8000/api/v1/auth/confirm \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","code":"123456"}'
```

3. **Login**
```bash
TOKEN=$(curl -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"Test1234!"}' \
  | jq -r .token)
```

4. **Upload a video** (presigned URL method)
```bash
# Request upload URL
UPLOAD=$(curl -X POST http://localhost:8000/api/v1/videos/upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contentType":"video/mp4"}')

VIDEO_ID=$(echo $UPLOAD | jq -r .videoId)
UPLOAD_URL=$(echo $UPLOAD | jq -r .uploadUrl)

# Upload file to S3
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/mp4" \
  --upload-file sample.mp4

# Mark upload complete
curl -X POST http://localhost:8000/api/v1/videos/$VIDEO_ID/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"My Test Video","duration":60}'
```

5. **List videos**
```bash
curl http://localhost:8000/api/v1/videos?page=1&pageSize=10 \
  -H "Authorization: Bearer $TOKEN"
```

6. **Get video details**
```bash
curl http://localhost:8000/api/v1/videos/$VIDEO_ID \
  -H "Authorization: Bearer $TOKEN"
```

7. **Stream/download**
```bash
# Get streaming URL
curl http://localhost:8000/api/v1/videos/$VIDEO_ID/stream?res=720 \
  -H "Authorization: Bearer $TOKEN"
```

### Cache Testing

```bash
# First request (CACHE_MISS in server logs)
curl http://localhost:8000/api/v1/videos?page=1 \
  -H "Authorization: Bearer $TOKEN"

# Second request (CACHE_HIT in server logs)
curl http://localhost:8000/api/v1/videos?page=1 \
  -H "Authorization: Bearer $TOKEN"

# Check server logs for:
# CACHE_MISS listVideos:v1:<userId>:ns0:page=1&pageSize=10
# CACHE_HIT listVideos:v1:<userId>:ns0:page=1&pageSize=10
```

## 📁 Project Structure

```
cab432/
├── src/
│   ├── index.js                 # Express app bootstrap
│   ├── config/
│   │   ├── parameterStore.js    # AWS SSM Parameter Store loader
│   │   └── secretManager.js     # AWS Secrets Manager loader
│   ├── routes/
│   │   ├── auth.js              # Cognito registration/login
│   │   ├── me.js                # User profile endpoint
│   │   ├── videos.js            # Video CRUD, list, cancel, delete
│   │   └── media.js             # Stream, download, thumbnail endpoints
│   ├── middleware/
│   │   └── auth.js              # JWT verification, group checks
│   ├── lib/
│   │   ├── paths.js             # DynamoDB repo, S3/DDB clients
│   │   ├── s3Presign.js         # S3 presigned URL generation
│   │   ├── ffmpeg.js            # FFmpeg wrappers (transcode, thumbnail)
│   │   ├── tagger.js            # Hugging Face image classification
│   │   ├── cache.js             # Memcached client wrapper
│   │   └── upload.js            # Multer config for multipart uploads
│   └── worker/
│       └── transcodeWorker.js   # Background job processor
├── public/                      # Frontend SPA (HTML/JS/CSS)
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   └── ...
├── Dockerfile                   # Production container image
├── docker-compose.yml           # Local dev with Memcached
├── package.json                 # Node dependencies
├── .env                         # Local env overrides (gitignored)
├── .dockerignore                # Exclude node_modules, data, .git
├── README.md                    # This file
├── ARCHITECTURE.md              # System design documentation
└── API_REFERENCE.md             # API endpoint reference
```

## 🔒 Security

- **No public S3 access**: All objects are private; access via presigned URLs only.
- **JWT verification**: Every protected route validates Cognito JWTs.
- **Secrets management**: Sensitive values loaded from AWS Secrets Manager at runtime.
- **IAM roles**: EC2 instance uses IAM role; no hardcoded credentials.
- **CORS**: Configurable via `CORS_ORIGIN` env var.

## 🛠️ Configuration

### AWS Secrets Manager

The app loads a JSON secret at `group57/A2/secret`:

```json
{
  "COGNITO_CLIENT_SECRET": "...",
  "HF_API_TOKEN": "hf_..."
}
```

### AWS Systems Manager Parameter Store

Parameters are loaded from `/cab432/g57/app/` prefix:

- `AWS_REGION`
- `PORT`
- `JWT_EXPIRES`
- `HF_IMAGE_MODEL`
- `TAGS_TOP_K`
- `TAGS_MIN_SCORE`
- `QUT_USERNAME`
- `TRANSCODE_LOCK_TTL_MS`

### Local Overrides

For local dev, set environment variables in `.env` or shell to bypass Parameter Store:

```bash
export USE_PARAMETER_STORE=false
export AWS_REGION=ap-southeast-2
export PORT=8000
# etc.
```

## 🐛 Troubleshooting

### Build fails with "invalid file request"
- **Cause**: OneDrive placeholder files or wrong build directory.
- **Fix**: Ensure repo is "Always keep on this device" in OneDrive, or move outside OneDrive.

### Worker not processing videos
- **Symptoms**: Videos stuck in "queued" status.
- **Checks**:
  - Worker logs: `docker logs cab432-app` (look for `[worker] <worker-id> starting`)
  - DynamoDB lock TTL: ensure `TRANSCODE_LOCK_TTL_MS` is reasonable (default 5 minutes)
  - FFmpeg: `docker exec cab432-app ffmpeg -version`

### Cache not working
- **Symptoms**: Always `CACHE_MISS` in logs.
- **Checks**:
  - Memcached endpoint: `echo $MEMCACHED_ENDPOINT`
  - Connectivity: `telnet <memcached-host> 11211`
  - Logs: check `[cache]` warnings

### Cognito errors
- **Symptoms**: "Invalid credentials" or "User not confirmed".
- **Checks**:
  - User confirmed: check Cognito console or confirm via `/auth/confirm`
  - Client secret: verify in Secrets Manager matches Cognito app client
  - JWT expiry: tokens expire; login again if stale

## 📈 Performance & Scaling

- **Stateless design**: Restart or scale horizontally without data loss.
- **Memcached caching**: Video list queries cached with namespace invalidation on mutations.
- **Worker concurrency**: Single worker processes one job at a time; deploy multiple instances for parallel processing (DynamoDB locks prevent collisions).
- **S3 presigned URLs**: Clients download/upload directly from S3, offloading traffic from the app server.

## 📝 License

ISC (see `package.json`)

## 👥 Contributors

- **Group 57**: QUT CAB432 Assessment 2 (2025)

## 🔗 Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design and cloud integration
- [API_REFERENCE.md](./API_REFERENCE.md) - Complete API endpoint reference
- [deploy.md](./deploy.md) - Detailed deployment guide (if exists)

---

**For questions or issues, consult the assignment specification or contact the teaching team.**
## Microservices Deployment

- **Service split**: `Dockerfile` builds the Express API container, `Dockerfile.worker` builds the CPU-intensive `transcodeWorker` service. Each service runs independently (ECS task or EC2 instance) and only shares AWS resources such as S3, DynamoDB, Parameter Store, Secrets Manager, and ElastiCache.
- **Local compose**: `docker compose up --build` now starts `app`, `worker`, and `memcached`. To run only the worker for isolated testing use `docker compose up worker memcached`.
- **Manual job injection**: If the API service is not yet available you can enqueue a job by (1) uploading an `original.mp4` into `s3://$S3_BUCKET/user/<USER_ID>/videos/<VIDEO_ID>/original.mp4`, and (2) inserting the matching DynamoDB item with status `queued` (see `src/lib/paths.js::videoRepo.create` for the item shape). The worker will poll DynamoDB and pick it up.
- **Local env**: Supply AWS credentials (via `~/.aws` volume) and either set `USE_PARAMETER_STORE=false` with explicit env vars in `.env`, or sign in with AWS SSO so the worker can read Parameter Store and Secrets Manager at startup.
- **ECS rollout**: Create a separate ECS/Fargate service for the worker image (e.g., `cab432-worker`) using the same IAM task role as the API, allocate higher CPU/memory, and point the task definition command to `npm run worker`. The service can scale independently using CloudWatch alarms on job backlog metrics.

### SQS job contract

- The versioned message schema that the API will publish to SQS is stored at `docs/contracts/sqs-video-job.v1.json`. The payload shape is:
  ```json
  {
    "v": 1,
    "jobId": "uuid-v4",
    "videoId": "ddb-key",
    "bucket": "videos-bucket",
    "originalKey": "originals/user/123/abc.mp4",
    "renditions": ["240p", "360p", "480p"],
    "userId": "cognito-sub",
    "submittedAt": 1739912345678
  }
  ```
- Team members must treat the worker contract as owned by the worker team. Any additions must be backward compatible (append-only). Bump `v` and add a new schema file if we ever introduce breaking changes.
- DLQ handling is intentionally deferred; we will wire SQS + DLQ logic in a subsequent iteration.

### SQS Load Distribution

- Set `SQS_QUEUE_URL` (and optional `TRANSCODE_RENDITIONS`, `SQS_WAIT_TIME_SECONDS`, `SQS_VISIBILITY_TIMEOUT_SECONDS`) so both the API and worker know which queue to use.
- The API publishes a versioned job (see `docs/contracts/sqs-video-job.v1.json`) whenever a video is created; failures mark the video as `failed` so the UI reflects the issue.
- The worker performs long polling against SQS, marks the video as `processing` in DynamoDB, and keeps the message invisible until FFmpeg finishes or a failure occurs. Unhandled failures allow SQS redrive/DLQ in future work.
- Local dev: run `docker compose up --build` (or `npm run start` + `npm run worker`) with AWS credentials and a real SQS queue so jobs flow end-to-end.
- Cloud: provision the queue + IAM permissions, inject the queue URL into both ECS task definitions, and scale the worker service based on `ApproximateNumberOfMessagesVisible`.
