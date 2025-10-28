# Architecture Documentation

## Table of Contents

- [System Overview](#system-overview)
- [Production Architecture](#production-architecture)
- [Architecture Diagram](#architecture-diagram)
- [Cloud Services](#cloud-services)
- [Data Models](#data-models)
- [Component Design](#component-design)
- [Data Flow](#data-flow)
- [Scaling Strategy](#scaling-strategy)
- [Stateless Design](#stateless-design)
- [Security & IAM](#security--iam)
- [Monitoring & Observability](#monitoring--observability)
- [Deployment Strategy](#deployment-strategy)

---

## System Overview

CAB432 Video Transcoding Platform is a **production-grade**, **cloud-native**, **decoupled** video processing application. The architecture separates concerns across two compute planes—**API (EC2)** and **Worker (ECS)**—connected via **SQS**, enabling independent scaling, fault isolation, and cost optimization.

### Core Principles

1. **Decoupling**: API and worker tiers scale independently via SQS queue
2. **Statelessness**: All persistent state lives in AWS services (S3, DynamoDB, Secrets Manager, Parameter Store)
3. **Auto-Scaling**: Custom metrics drive worker scaling; ALB metrics drive API scaling
4. **Fault Tolerance**: SQS retries + DLQ isolation, health checks, graceful degradation
5. **Cloud-Native**: Leverages managed AWS services for auth, storage, database, queuing, caching, orchestration

---

## Production Architecture

### Deployment Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Internet / Client                                 │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    │ HTTPS (443)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Route 53 (DNS)                                    │
│  CNAME: g58.cab432.com → ALB-dns-name.elb.amazonaws.com                     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Application Load Balancer (ALB)                                 │
│  - HTTPS listener (ACM certificate)                                          │
│  - Health checks: /api/v1/health (30s interval)                             │
│  - Connection draining: 300s                                                 │
│  - Target: EC2 Auto Scaling Group (port 8000)                               │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    │ HTTP (8000)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               EC2 Auto Scaling Group (API Tier)                              │
│  - Launch Template: Amazon Linux 2023 + Docker                              │
│  - Instance Type: t3.medium (2 vCPU, 4 GiB RAM)                             │
│  - Container: g57-a2:v8 (Express API)                                        │
│  - Scaling Policy:                                                           │
│    * Target: 70% CPU utilization                                             │
│    * Min: 2, Max: 10                                                         │
│    * Warmup: 300s                                                            │
│  - IAM Role: AmazonS3FullAccess, DynamoDBFullAccess,                        │
│              SecretsManagerReadWrite, SSMReadOnly, ElastiCache              │
└─┬──────────────────┬──────────────────┬──────────────────┬─────────────────┘
  │                  │                  │                  │
  │                  │                  │                  │
  ▼                  ▼                  ▼                  ▼
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────────────┐
│ Cognito │    │    S3    │    │ DynamoDB  │    │ ElastiCache      │
│UserPool │    │  Bucket  │    │   Table   │    │ (Memcached)      │
│         │    │ (private)│    │           │    │                  │
└─────────┘    └──────────┘    └───────────┘    └──────────────────┘
                     │               │
                     │               │
                     └───────┬───────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SQS Queue (Job Decoupling)                           │
│  Queue: a3-g58-workerqueue                                                   │
│  - VisibilityTimeout: 900s (15 min)                                          │
│  - MaxReceiveCount: 3 (retry limit)                                          │
│  - DLQ: a3-g58-workerqueue-dlq (poison messages)                             │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    │ Poll (long-polling, 20s)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Amazon ECS Service (Worker Tier)                                │
│  - Launch Type: Fargate                                                      │
│  - Task Definition: g57-worker:8 (FFmpeg container)                          │
│  - CPU: 1024, Memory: 2048                                                   │
│  - Scaling Policy (Application Auto Scaling):                                │
│    * Custom Metric: BacklogPerWorker                                         │
│    * Target: 2.0 (messages per worker)                                       │
│    * Min: 1, Max: 20                                                         │
│    * Scale-Out Cooldown: 60s                                                 │
│    * Scale-In Cooldown: 300s                                                 │
│  - IAM Role: AmazonS3FullAccess, DynamoDBFullAccess, SQSFullAccess          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Write outputs
                                    ▼
                             ┌──────────┐
                             │    S3    │
                             │  Bucket  │
                             │(renditions│
                             │thumbnails)│
                             └──────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│              EventBridge + Lambda (Custom Metrics)                           │
│  - EventBridge Rule: rate(1 minute)                                          │
│  - Lambda: g58-lambda-customscaling                                          │
│    * Query SQS queue attributes (ApproximateNumberOfMessages, NotVisible)   │
│    * Query ECS service (RunningTaskCount)                                    │
│    * Calculate: BacklogPerWorker = (visible + notVisible) / runningCount    │
│    * Publish to CloudWatch Metrics: CAB432/VideoTranscoding                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   CloudWatch (Observability)                                 │
│  - Logs: /ecs/g57-api, /ecs/g57-worker, /aws/lambda/g58-lambda-*            │
│  - Metrics: BacklogPerWorker, RunningWorkerTasks, ALB metrics, ECS metrics  │
│  - Alarms: DLQ depth > 0, Unhealthy hosts > 0, High backlog                 │
│  - Dashboard: API/Worker/Queue/Cache metrics in single view                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│              Secrets Manager + SSM Parameter Store                           │
│  - Secrets Manager: group57/A2/secret (Cognito client secret, API tokens)   │
│  - Parameter Store: /cab432/group57/* (region, model names, TTLs)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Scaling Trigger |
|-----------|---------------|-----------------|
| **Route 53** | DNS resolution to ALB | N/A (global service) |
| **ALB** | HTTPS termination, health checks, traffic distribution | N/A (managed service) |
| **EC2 API** | User auth, metadata CRUD, presigned URL generation, SQS job enqueueing | CPU utilization, ALB request count |
| **SQS Queue** | Job decoupling, fault tolerance, retry logic | N/A (auto-scales) |
| **ECS Worker** | Poll queue, transcode videos, upload outputs, update metadata | Custom metric: BacklogPerWorker |
| **EventBridge + Lambda** | Collect queue depth, ECS task count, publish CloudWatch metrics | Scheduled (every 60s) |
| **S3** | Object storage (originals, renditions, thumbnails) | N/A (infinite capacity) |
| **DynamoDB** | Video metadata, job state, worker locks | Auto-scaling (pay-per-request) |
| **ElastiCache** | Cache video list queries | N/A (fixed cluster size) |
| **Cognito** | User registration, login, JWT issuance | N/A (managed service) |
| **Secrets Manager** | Sensitive credentials | N/A (managed service) |
| **Parameter Store** | Non-sensitive config | N/A (managed service) |
| **CloudWatch** | Centralized logging, metrics, alarms, dashboards | N/A (managed service) |

---

## Architecture Diagram (Detailed Data Flow)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Video Upload Flow                                  │
└──────────────────────────────────────────────────────────────────────────┘

1. Client → Route 53 → ALB → EC2: POST /api/v1/videos/upload-url
   ├─ API verifies JWT (Cognito public key)
   ├─ API creates video record in DynamoDB (status=queued)
   ├─ API enqueues job to SQS: {userId, videoId, originalKey}
   └─ API generates presigned S3 PUT URL (60 min expiry)

2. Client → S3: PUT <presigned-url> (upload original.mp4)
   ├─ Direct client → S3 upload (bypasses API, reduces API load)
   └─ S3 stores: user/{userId}/videos/{videoId}/original.mp4

3. Client → Route 53 → ALB → EC2: POST /api/v1/videos/:id/complete
   ├─ API updates DynamoDB: status=queued, originalKey, title, duration
   └─ API invalidates ElastiCache namespace (increment counter)

┌──────────────────────────────────────────────────────────────────────────┐
│                      Video Transcoding Flow                               │
└──────────────────────────────────────────────────────────────────────────┘

4. ECS Worker → SQS: ReceiveMessage (long-poll 20s)
   ├─ Worker receives: {userId, videoId, originalKey}
   └─ Worker extends VisibilityTimeout (900s)

5. Worker → DynamoDB: Update (status=processing, transcodeLockedBy, transcodeLockedAt)
   ├─ Conditional write ensures only one worker processes job
   └─ If condition fails, another worker already claimed job

6. Worker → S3: GetObject (download original.mp4 to local tmp/)

7. Worker → FFmpeg: Transcode
   ├─ Generate renditions: 1080p, 720p, 480p (H.264, AAC, MP4)
   ├─ Extract thumbnail at 3s mark (JPEG)
   └─ Detect duration (ffprobe)

8. Worker → S3: PutObject (upload renditions + thumbnail)
   ├─ user/{userId}/videos/{videoId}/renditions/1080p.mp4
   ├─ user/{userId}/videos/{videoId}/renditions/720p.mp4
   ├─ user/{userId}/videos/{videoId}/renditions/480p.mp4
   └─ user/{userId}/videos/{videoId}/thumbnail.jpg

9. Worker → DynamoDB: Update (status=completed, renditions, thumbnailKey, duration)
   ├─ Remove lock: transcodeLockedBy=null, transcodeLockedAt=null
   └─ Invalidate cache namespace

10. Worker → SQS: DeleteMessage (acknowledge success)

┌──────────────────────────────────────────────────────────────────────────┐
│                      Failure Handling Flow                                │
└──────────────────────────────────────────────────────────────────────────┘

11. Worker failure scenarios:
   ├─ S3 NoSuchKey (original missing): status=failed, errorMessage
   ├─ FFmpeg error (corrupt file): status=failed, errorMessage
   ├─ Network timeout: VisibilityTimeout expires, message reappears
   └─ After 3 receive attempts: SQS moves message to DLQ

12. DLQ message:
   ├─ CloudWatch Alarm: ApproximateNumberOfMessages > 0 → SNS notification
   ├─ Manual inspection via AWS Console or CLI
   └─ Replay after fix: ChangeMessageVisibility, then receive again

┌──────────────────────────────────────────────────────────────────────────┐
│                      Video Streaming Flow                                 │
└──────────────────────────────────────────────────────────────────────────┘

13. Client → Route 53 → ALB → EC2: GET /api/v1/videos/:id
   ├─ API checks ElastiCache for cached video metadata
   ├─ Cache MISS: API queries DynamoDB, writes to cache (TTL 300s)
   └─ Cache HIT: API returns cached data (sub-ms latency)

14. Client → Route 53 → ALB → EC2: GET /api/v1/videos/:id/stream?res=720
   ├─ API verifies JWT
   ├─ API reads video metadata from DynamoDB
   ├─ API generates presigned S3 GET URL for renditions/720p.mp4 (60 min expiry)
   └─ API returns presigned URL to client

15. Client → S3: GET <presigned-url> (stream 720p.mp4)
   ├─ Direct client → S3 streaming (bypasses API, reduces API load)
   └─ S3 supports range requests (HTTP 206) for video seeking

┌──────────────────────────────────────────────────────────────────────────┐
│                      Custom Scaling Flow                                  │
└──────────────────────────────────────────────────────────────────────────┘

16. EventBridge → Lambda (every 60s):
   ├─ Lambda → SQS: GetQueueAttributes (ApproximateNumberOfMessages, NotVisible)
   ├─ Lambda → ECS: DescribeServices (runningCount)
   ├─ Lambda calculates: BacklogPerWorker = (visible + notVisible) / runningCount
   └─ Lambda → CloudWatch: PutMetricData (BacklogPerWorker, QueueVisible, etc.)

17. CloudWatch Metric: BacklogPerWorker > 2.0 (target value)
   ├─ Application Auto Scaling Policy triggered
   ├─ ECS → UpdateService (desiredCount = runningCount + scaleOutIncrement)
   └─ New Fargate tasks launched (60s warmup)

18. CloudWatch Metric: BacklogPerWorker < 1.0 (below target)
   ├─ Scale-In Cooldown (300s) prevents flapping
   ├─ Application Auto Scaling Policy triggered
   └─ ECS → UpdateService (desiredCount = runningCount - scaleInIncrement)
```

---

## Cloud Services

### AWS Cognito (Authentication)

**Purpose**: Managed user authentication, JWT issuance, group-based authorization

**Configuration**:
- User Pool: `cab432-user-pool`
- App Client: `cab432-app-client` (with client secret)
- Password Policy: Min 8 chars, uppercase, lowercase, number, symbol
- Email Verification: Required before login
- MFA: Optional (TOTP)
- Groups: `Admin` (grants delete permissions)

**Integration**:
- Client: `POST /api/v1/auth/register` → Cognito SignUp → email confirmation code
- Client: `POST /api/v1/auth/confirm` → Cognito ConfirmSignUp
- Client: `POST /api/v1/auth/login` → Cognito InitiateAuth → IdToken (JWT)
- API: `aws-jwt-verify` library validates JWT signature, expiry, issuer, audience
- API: Extracts `cognito:username`, `cognito:groups` from JWT claims

**Why Cognito**:
- Eliminates need to manage user database, password hashing, email sending
- Built-in JWT validation, token refresh, MFA, OAuth2 flows
- Integrates with API Gateway, Lambda, ALB for authentication
- Scales automatically, no capacity planning

### Amazon S3 (Object Storage)

**Purpose**: Store video files (originals, renditions, thumbnails)

**Configuration**:
- Bucket: `g57-cab432-bucket` (private, no public access)
- Versioning: Enabled (rollback accidental deletes)
- Encryption: SSE-S3 (server-side encryption)
- Lifecycle Rules: Archive originals to Glacier after 90 days (optional)
- CORS: Allow PUT/GET from client origin (for presigned URLs)

**Key Structure**:
- Original: `user/{userId}/videos/{videoId}/original.mp4`
- Renditions: `user/{userId}/videos/{videoId}/renditions/{1080p|720p|480p}.mp4`
- Thumbnail: `user/{userId}/videos/{videoId}/thumbnail.jpg`

**Presigned URLs**:
- Generated via `@aws-sdk/s3-request-presigner`
- Upload: `PUT` URL (60 min expiry) for client → S3 direct upload
- Download: `GET` URL (60 min expiry) for streaming/download
- Benefits: Offloads traffic from API, secure (expires), no credentials in client

**Why S3**:
- Infinite capacity, no provisioning, pay-per-GB
- 99.999999999% (11 9's) durability across multiple AZs
- Supports range requests (HTTP 206) for video seeking
- Integrates with CloudFront for CDN distribution

### Amazon DynamoDB (Metadata & Job Queue)

**Purpose**: Store video metadata, job state, worker locks

**Configuration**:
- Table: `cab432-videos`
- Partition Key: `qut-username` (STRING)
- Sort Key: `SK` (STRING)
- Billing Mode: Pay-per-request (auto-scaling, no capacity planning)
- Indexes: None (query patterns use PK + SK)
- TTL: Optional (auto-delete old videos)

**Items**:
- **Video**: `SK = USER#<userId>#VIDEO#<videoId>`
  - Attributes: `title`, `status`, `originalKey`, `thumbnailKey`, `renditions`, `duration`, `tags`, `errorMessage`, `transcodeLockedBy`, `transcodeLockedAt`, `createdAt`, `updatedAt`

**Video Status Lifecycle**:
```
queued → processing → completed
              ↓
           failed (on error or cancel)
```

**Worker Locking**:
- Worker claims job by setting `transcodeLockedBy` (workerId) and `transcodeLockedAt` (timestamp)
- Conditional write ensures only one worker processes job: `attribute_not_exists(transcodeLockedBy) OR transcodeLockedAt < :staleThreshold`
- Stale locks (older than 15 min) are reclaimed by other workers
- On completion/failure, lock is removed

**Query Patterns**:
- List all videos: `PK = qut-username, SK begins_with USER#<userId>#VIDEO#`
- Get single video: `PK = qut-username, SK = USER#<userId>#VIDEO#<videoId>`
- List queued jobs: Query + filter `status = queued`

**Why DynamoDB**:
- Single-digit millisecond latency at any scale
- No server management, auto-scaling, no capacity planning
- Supports conditional writes for distributed locking
- Integrates with DynamoDB Streams for event-driven architectures

### Amazon SQS (Job Queue)

**Purpose**: Decouple API from workers, enable asynchronous processing

**Configuration**:
- Queue: `a3-g58-workerqueue`
  - VisibilityTimeout: 900s (15 min, covers transcode time)
  - ReceiveMessageWaitTimeSeconds: 20s (long-polling)
  - MaxReceiveCount: 3 (retry limit before DLQ)
  - DelaySeconds: 0 (immediate delivery)
- Dead Letter Queue: `a3-g58-workerqueue-dlq`
  - Captures messages after 3 failed attempts
  - CloudWatch Alarm monitors depth > 0

**Message Format**:
```json
{
  "userId": "c93eb4a8-5091-7039-cb90-5408488a9de5",
  "videoId": "123e4567-e89b-12d3-a456-426614174000",
  "originalKey": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/original.mp4"
}
```

**Why SQS**:
- Decouples API from workers (API doesn't wait for transcoding)
- At-least-once delivery (message not lost even if worker crashes)
- Auto-scaling (no capacity planning, handles any message volume)
- DLQ isolation prevents poison messages from blocking queue
- Long-polling reduces empty receives, lowers costs

### Amazon ECS (Container Orchestration)

**Purpose**: Run FFmpeg worker containers on Fargate

**Configuration**:
- Cluster: `g57-cluster`
- Service: `g57-worker-service`
  - Task Definition: `g57-worker:8`
  - Launch Type: Fargate (serverless)
  - CPU: 1024 (1 vCPU), Memory: 2048 (2 GiB)
  - Desired Count: Dynamic (1-20, controlled by Application Auto Scaling)
  - Network Mode: awsvpc (each task gets ENI)
  - Subnets: Private subnets (no direct internet access, NAT gateway for S3/DynamoDB)

**Task Definition**:
```json
{
  "family": "g57-worker",
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "worker",
      "image": "901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2-worker:v8",
      "environment": [
        {"name": "AWS_REGION", "value": "ap-southeast-2"},
        {"name": "WORKER_MODE", "value": "true"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/g57-worker",
          "awslogs-region": "ap-southeast-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

**Why ECS Fargate**:
- No server management (vs. EC2, self-managed Kubernetes)
- Built-in task isolation, auto-recovery on failures
- Pay-per-second billing (no idle instance costs)
- Integrates with Application Auto Scaling for custom metrics
- CloudWatch Logs integration for centralized logging

### AWS EventBridge + Lambda (Custom Metrics)

**Purpose**: Collect queue depth and ECS task count, publish CloudWatch metrics for scaling

**Configuration**:
- EventBridge Rule: `g57-scaling-metrics`
  - Schedule: `rate(1 minute)`
  - Target: Lambda function `g58-lambda-customscaling`
- Lambda:
  - Runtime: Node.js 20.x
  - Timeout: 60s
  - Memory: 256 MB
  - Environment Variables: `QUEUE_URL`, `CLUSTER_NAME`, `SERVICE_NAME`, `METRIC_NAMESPACE`

**Logic**:
1. Query SQS: `GetQueueAttributes` (ApproximateNumberOfMessages, ApproximateNumberOfMessagesNotVisible)
2. Query ECS: `DescribeServices` (runningCount)
3. Calculate: `BacklogPerWorker = (visible + notVisible) / runningCount`
4. Publish CloudWatch Metrics:
   - `QueueVisible` (Count)
   - `QueueNotVisible` (Count)
   - `RunningWorkerTasks` (Count)
   - `BacklogPerWorker` (Count)

**Why EventBridge + Lambda**:
- SQS/ECS don't natively emit `BacklogPerWorker` metric
- Lambda is serverless (no server management, pay-per-invocation)
- EventBridge provides reliable, scheduled triggers
- CloudWatch Custom Metrics integrate with Application Auto Scaling

### AWS Secrets Manager & SSM Parameter Store

**Secrets Manager**: Stores sensitive credentials
- Secret Name: `group57/A2/secret`
- Format: JSON
  ```json
  {
    "COGNITO_CLIENT_SECRET": "...",
    "HF_API_TOKEN": "hf_...",
    "DB_ENCRYPTION_KEY": "..."
  }
  ```
- Features: Automatic rotation, encryption at rest (KMS), audit logs (CloudTrail)
- Integration: API/Worker fetch secrets at startup via `@aws-sdk/client-secrets-manager`

**Parameter Store**: Stores non-sensitive config
- Prefix: `/cab432/group57/`
- Parameters:
  - `/cab432/group57/AWS_REGION` = `ap-southeast-2`
  - `/cab432/group57/HF_IMAGE_MODEL` = `google/vit-base-patch16-224`
  - `/cab432/group57/TAGS_TOP_K` = `5`
  - `/cab432/group57/TRANSCODE_LOCK_TTL_MS` = `900000`
- Features: Hierarchical namespacing, version history, free tier
- Integration: API/Worker fetch parameters at startup via `@aws-sdk/client-ssm`

**Why separate Secrets Manager + Parameter Store**:
- Secrets Manager: Automatic rotation, higher cost ($0.40/secret/month)
- Parameter Store: No rotation, lower cost (free for standard parameters)
- Best practice: Sensitive in Secrets Manager, non-sensitive in Parameter Store

### AWS ElastiCache (Memcached)

**Purpose**: Cache hot video list queries, reduce DynamoDB reads

**Configuration**:
- Cluster: `g57-memcache`
- Engine: Memcached 1.6.17
- Node Type: cache.t3.micro (1 vCPU, 0.5 GiB RAM)
- Number of Nodes: 1 (multi-node for HA in production)
- Endpoint: `g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211`

**Caching Strategy**:
- **Cache Key**: `videos:list:{userId}:v{namespaceVersion}:p{page}:n{pageSize}:s{sortBy}|s:{status}|t:{tags}|q:{search}`
- **Namespace Invalidation**: Increment namespace version on mutations (create, update, delete)
  - Counter key: `videos:list:ns:{userId}`
  - All list cache keys include namespace version → invalidation without explicit deletes
- **TTL**: 300s (5 min) for list queries
- **Graceful Degradation**: If Memcached unavailable, fallback to DynamoDB

**Why Memcached (vs. Redis)**:
- Simpler (no persistence, replication, clustering complexity)
- Multi-threaded (better CPU utilization)
- Lower cost for simple key-value caching
- LRU eviction (auto-expires least-recently-used keys)

---

## Data Models

### Video (DynamoDB)

```json
{
  "qut-username": "group57",
  "SK": "USER#c93eb4a8-5091-7039-cb90-5408488a9de5#VIDEO#123e4567-e89b-12d3-a456-426614174000",
  "userId": "c93eb4a8-5091-7039-cb90-5408488a9de5",
  "videoId": "123e4567-e89b-12d3-a456-426614174000",
  "title": "My Vacation Video",
  "status": "completed",
  "originalKey": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/original.mp4",
  "thumbnailKey": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/thumbnail.jpg",
  "renditions": {
    "1080p": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/renditions/1080p.mp4",
    "720p": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/renditions/720p.mp4",
    "480p": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/renditions/480p.mp4"
  },
  "duration": 120.5,
  "tags": ["beach", "sunset", "travel"],
  "transcodeLockedBy": null,
  "transcodeLockedAt": null,
  "errorMessage": null,
  "createdAt": "2024-01-15T08:30:00.000Z",
  "updatedAt": "2024-01-15T08:35:45.000Z"
}
```

### SQS Message (Job)

```json
{
  "userId": "c93eb4a8-5091-7039-cb90-5408488a9de5",
  "videoId": "123e4567-e89b-12d3-a456-426614174000",
  "originalKey": "user/c93eb4a8-5091-7039-cb90-5408488a9de5/videos/123e4567-e89b-12d3-a456-426614174000/original.mp4"
}
```

### Cache Entry (Video List)

```json
{
  "items": [
    {
      "videoId": "123e4567-e89b-12d3-a456-426614174000",
      "title": "My Vacation Video",
      "status": "completed",
      "duration": 120.5,
      "thumbnailKey": "user/.../thumbnail.jpg",
      "tags": ["beach", "sunset", "travel"],
      "createdAt": "2024-01-15T08:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 25,
    "totalPages": 3
  }
}
```

---

## Component Design

### API Server (`src/api/service.js`)

**Responsibilities**:
- Serve static frontend (HTML/JS/CSS)
- Handle user authentication (Cognito signup/confirm/login)
- Video metadata CRUD (create, read, list, delete)
- Generate presigned S3 URLs (upload, download, streaming)
- Enqueue transcoding jobs to SQS
- Cache video list queries (ElastiCache)

**Key Endpoints**:
- `POST /api/v1/auth/register` → Cognito SignUp
- `POST /api/v1/auth/confirm` → Cognito ConfirmSignUp
- `POST /api/v1/auth/login` → Cognito InitiateAuth
- `POST /api/v1/videos/upload-url` → Create video record, enqueue SQS job, return presigned PUT URL
- `POST /api/v1/videos/:id/complete` → Update video metadata after client uploads
- `GET /api/v1/videos` → List videos (with cache)
- `GET /api/v1/videos/:id` → Get video metadata
- `GET /api/v1/videos/:id/stream` → Generate presigned GET URL for rendition
- `DELETE /api/v1/videos/:id` → Delete video (admin-only)

**Statelessness**:
- No local state (cookies, sessions, files)
- All config from Secrets Manager + Parameter Store
- JWT verification via public key (no session lookup)
- Cache namespace invalidation (no explicit cache deletes)

### Worker (`src/worker/transcodeWorker.js`)

**Responsibilities**:
- Poll SQS queue for jobs (long-polling)
- Claim job via DynamoDB conditional write (distributed locking)
- Download original video from S3
- Transcode to multiple resolutions (FFmpeg)
- Generate thumbnail (FFmpeg)
- Upload renditions + thumbnail to S3
- Update DynamoDB with metadata (renditions, duration, status)
- Delete SQS message (acknowledge success)
- Handle failures (retry, DLQ, error logging)

**Concurrency Model**:
- Single worker processes one job at a time (sequential)
- Multiple workers (ECS tasks) process jobs in parallel
- No shared state between workers (idempotent operations)
- Stale lock reclaim ensures job processing resumes on worker crash

**FFmpeg Configuration**:
- H.264 codec (libx264), AAC audio, MP4 container
- Presets: medium (balance quality/speed)
- Resolutions: 1080p (1920x1080), 720p (1280x720), 480p (854x480)
- Bitrates: 1080p (5000k), 720p (2500k), 480p (1000k)
- Thumbnail: JPEG at 3s mark, 640x360

---

## Data Flow

### Upload Flow (Detailed)

```
1. Client: POST /api/v1/videos/upload-url
   └─ Headers: Authorization: Bearer <JWT>
   └─ Body: {contentType: "video/mp4"}

2. API: Verify JWT (cognito:username, cognito:groups)
   └─ aws-jwt-verify library validates signature, expiry, issuer

3. API: Generate videoId (uuidv7), originalKey
   └─ videoId = "123e4567-e89b-12d3-a456-426614174000"
   └─ originalKey = "user/<userId>/videos/<videoId>/original.mp4"

4. API → DynamoDB: PutItem
   └─ Item: {qut-username, SK, userId, videoId, status=queued, originalKey, createdAt}

5. API → SQS: SendMessage
   └─ Message: {userId, videoId, originalKey}
   └─ Queue: a3-g58-workerqueue

6. API → S3: Generate presigned PUT URL
   └─ URL expires in 60 min
   └─ Client uploads directly to S3 (bypasses API)

7. API → Client: 201 Created
   └─ Body: {videoId, uploadUrl, expiresIn: 3600}

8. Client → S3: PUT <uploadUrl> (upload original.mp4)
   └─ Direct upload (no API involvement)

9. Client: POST /api/v1/videos/:id/complete
   └─ Body: {title: "My Video", duration: 120.5}

10. API → DynamoDB: UpdateItem
    └─ Set: title, duration, updatedAt

11. API → ElastiCache: Increment namespace counter
    └─ videos:list:ns:<userId> += 1
    └─ All cached lists invalidated (namespace version changed)
```

### Transcode Flow (Detailed)

```
1. ECS Worker: Poll SQS (long-polling, 20s)
   └─ ReceiveMessage (MaxNumberOfMessages=1, WaitTimeSeconds=20)
   └─ Message: {userId, videoId, originalKey}

2. Worker: Claim job (DynamoDB conditional write)
   └─ UpdateItem: status=processing, transcodeLockedBy=<workerId>, transcodeLockedAt=<now>
   └─ Condition: attribute_not_exists(transcodeLockedBy) OR transcodeLockedAt < :staleThreshold
   └─ If condition fails: Another worker already claimed job, skip

3. Worker → S3: GetObject (download original.mp4 to /tmp/)
   └─ Stream download to local filesystem

4. Worker: FFmpeg transcode
   ├─ 1080p: ffmpeg -i original.mp4 -vf scale=1920:1080 -b:v 5000k -preset medium 1080p.mp4
   ├─ 720p: ffmpeg -i original.mp4 -vf scale=1280:720 -b:v 2500k -preset medium 720p.mp4
   ├─ 480p: ffmpeg -i original.mp4 -vf scale=854:480 -b:v 1000k -preset medium 480p.mp4
   └─ Thumbnail: ffmpeg -ss 3 -i original.mp4 -frames:v 1 -vf scale=640:360 thumbnail.jpg

5. Worker → S3: PutObject (upload renditions + thumbnail)
   ├─ user/<userId>/videos/<videoId>/renditions/1080p.mp4
   ├─ user/<userId>/videos/<videoId>/renditions/720p.mp4
   ├─ user/<userId>/videos/<videoId>/renditions/480p.mp4
   └─ user/<userId>/videos/<videoId>/thumbnail.jpg

6. Worker → DynamoDB: UpdateItem
   └─ Set: status=completed, renditions, thumbnailKey, duration, updatedAt
   └─ Remove: transcodeLockedBy, transcodeLockedAt, errorMessage

7. Worker → ElastiCache: Increment namespace counter
   └─ videos:list:ns:<userId> += 1

8. Worker → SQS: DeleteMessage (acknowledge success)
   └─ Message removed from queue

9. Worker: Clean up local /tmp/ files
```

### Failure Flow (Detailed)

```
Scenario A: S3 original not found (NoSuchKey)
1. Worker → S3: GetObject fails (NoSuchKey)
2. Worker → DynamoDB: UpdateItem (status=failed, errorMessage="Original file not found")
3. Worker → SQS: DeleteMessage (don't retry, permanent failure)

Scenario B: FFmpeg error (corrupt file)
1. Worker: FFmpeg transcode fails (exit code 1)
2. Worker → DynamoDB: UpdateItem (status=failed, errorMessage="Transcode failed: <error>")
3. Worker → SQS: DeleteMessage (don't retry, permanent failure)

Scenario C: Network timeout (worker crash mid-transcode)
1. Worker crashes (container terminated, out-of-memory, etc.)
2. SQS: VisibilityTimeout (900s) expires → message reappears in queue
3. Another worker receives message, claims job (conditional write succeeds if lock stale)
4. Worker resumes transcode from scratch (idempotent operation)

Scenario D: Repeated failures (retry exhaustion)
1. Worker fails 3 times (MaxReceiveCount=3)
2. SQS: Move message to DLQ (a3-g58-workerqueue-dlq)
3. CloudWatch Alarm: DLQ depth > 0 → SNS notification
4. Admin: Inspect DLQ message body, fix issue (e.g., restore S3 file)
5. Admin: Replay message (ChangeMessageVisibility → ReceiveMessage → process → DeleteMessage)
```

---

## Scaling Strategy

### API Tier (EC2 Auto Scaling)

**Trigger**: ALB Request Count per Target + CPU Utilization

**Target Tracking Policy 1: CPU Utilization**
- Target: 70% average CPU
- Metric: `AWS/EC2` `CPUUtilization`
- Scale-Out: If CPU > 70% for 2 consecutive data points (60s each)
- Scale-In: If CPU < 70% for 15 consecutive data points (300s cooldown)

**Target Tracking Policy 2: ALB Request Count**
- Target: 1000 requests/target/minute
- Metric: `AWS/ApplicationELB` `RequestCountPerTarget`
- Scale-Out: If requests > 1000 for 1 data point (60s)
- Scale-In: If requests < 1000 for 5 data points (300s cooldown)

**Capacity**:
- Min: 2 instances (high availability across 2 AZs)
- Max: 10 instances (burst capacity)
- Desired: Dynamic (controlled by scaling policies)
- Warmup: 300s (time for instance to become healthy)

**Why ALB + EC2**:
- Cost-effective for steady, predictable traffic
- Flexible instance types (t3, c5, m5, etc.)
- Easy to debug (SSH access, CloudWatch Logs)
- ALB health checks ensure unhealthy instances drained

### Worker Tier (ECS Application Auto Scaling)

**Trigger**: Custom Metric (BacklogPerWorker)

**Target Tracking Policy**:
- Target: 2.0 messages per worker
- Metric: `CAB432/VideoTranscoding` `BacklogPerWorker` (custom)
- Scale-Out: If BacklogPerWorker > 2.0 for 1 data point (60s)
  - New tasks launched immediately (no warmup delay)
- Scale-In: If BacklogPerWorker < 2.0 for 5 consecutive data points (300s cooldown)
  - Prevents flapping (rapid scale-out/scale-in cycles)

**Capacity**:
- Min: 1 task (cost optimization, always 1 worker available)
- Max: 20 tasks (burst capacity, handles large upload spikes)
- Desired: Dynamic (controlled by Application Auto Scaling)

**Custom Metric Collection (EventBridge + Lambda)**:
- EventBridge Rule: Triggers Lambda every 60s
- Lambda Logic:
  ```javascript
  const visible = queueAttributes.ApproximateNumberOfMessages;
  const notVisible = queueAttributes.ApproximateNumberOfMessagesNotVisible;
  const runningCount = ecsService.runningCount || 1; // Avoid divide-by-zero
  const backlogPerWorker = (visible + notVisible) / runningCount;
  ```
- Lambda publishes metrics to CloudWatch: `BacklogPerWorker`, `QueueVisible`, `QueueNotVisible`, `RunningWorkerTasks`

**Why Custom Metric**:
- SQS `ApproximateNumberOfMessages` alone doesn't account for in-flight messages (`ApproximateNumberOfMessagesNotVisible`)
- ECS `DesiredCount` is lagging indicator (doesn't reflect actual running tasks during scale-out)
- `BacklogPerWorker` = total work / available workers = optimal scaling signal

**Example Scaling Scenario**:
```
Time 0: 10 videos uploaded (queue depth = 10), 1 running worker
  └─ BacklogPerWorker = 10 / 1 = 10.0 > 2.0 → Scale-Out triggered

Time 60s: Lambda publishes BacklogPerWorker = 10.0
  └─ Application Auto Scaling: desiredCount = 5 (10 / 2 = 5 workers)

Time 120s: 5 workers running, queue depth = 5 (workers processing)
  └─ BacklogPerWorker = 5 / 5 = 1.0 < 2.0 → Scale-In cooldown (300s)

Time 420s (300s cooldown elapsed): Queue depth = 0
  └─ BacklogPerWorker = 0 / 5 = 0.0 < 2.0 → Scale-In triggered
  └─ Application Auto Scaling: desiredCount = 1 (min capacity)
```

---

## Stateless Design

### Statelessness Principles

1. **No Local State**: API/Worker don't store persistent data locally (no cookies, sessions, files)
2. **Externalized Config**: All config from Secrets Manager + Parameter Store (fetched at startup)
3. **Externalized Storage**: All data in S3 (videos), DynamoDB (metadata), ElastiCache (cache)
4. **Idempotent Operations**: Workers can be killed/restarted without data loss (SQS retries, DynamoDB locks)
5. **Horizontal Scalability**: Add/remove instances without coordination (no sticky sessions, no leader election)

### Benefits

- **Horizontal Scaling**: Add instances without state migration
- **High Availability**: Instance failures don't lose data
- **Rolling Deployments**: Replace instances without downtime
- **Disaster Recovery**: Recreate infrastructure from code (Terraform)
- **Cost Optimization**: Scale to zero (ECS tasks) when no work

### State Externalization

| State Type | Storage | TTL/Retention |
|------------|---------|---------------|
| **User Credentials** | AWS Cognito | 90 days inactive |
| **JWT Tokens** | Client-side (localStorage) | 1 hour (configurable) |
| **Video Files (originals)** | S3 | 90 days (lifecycle to Glacier) |
| **Video Files (renditions)** | S3 | Indefinite (or lifecycle) |
| **Video Metadata** | DynamoDB | Indefinite (or TTL) |
| **Job Queue** | SQS | 14 days (MessageRetentionPeriod) |
| **Cache** | ElastiCache | 300s (explicit TTL) |
| **Secrets** | Secrets Manager | Indefinite (rotation policy) |
| **Config** | SSM Parameter Store | Indefinite (version history) |
| **Logs** | CloudWatch Logs | 7 days (retention policy) |

---

## Security & IAM

### IAM Roles

**EC2 API Role** (`g57-ec2-api-role`):
- Policies:
  - `AmazonS3FullAccess` (or scoped to `g57-cab432-bucket`)
  - `AmazonDynamoDBFullAccess` (or scoped to `cab432-videos` table)
  - `SecretsManagerReadWrite` (or read-only for `group57/A2/secret`)
  - `AmazonSSMReadOnlyAccess` (or scoped to `/cab432/group57/*`)
  - `ElastiCacheFullAccess` (or scoped to `g57-memcache`)
  - `CloudWatchLogsFullAccess` (write logs)
- Trust Policy: Allow EC2 service to assume role

**ECS Worker Role** (`g57-ecs-worker-role`):
- Policies:
  - `AmazonS3FullAccess` (or scoped to `g57-cab432-bucket`)
  - `AmazonDynamoDBFullAccess` (or scoped to `cab432-videos` table)
  - `AmazonSQSFullAccess` (or scoped to `a3-g58-workerqueue`)
  - `SecretsManagerReadWrite` (or read-only for `group57/A2/secret`)
  - `AmazonSSMReadOnlyAccess` (or scoped to `/cab432/group57/*`)
  - `CloudWatchLogsFullAccess` (write logs)
- Trust Policy: Allow ECS service to assume role

**Lambda Metrics Role** (`g58-lambda-customscaling-role`):
- Policies:
  - `AmazonSQSReadOnlyAccess` (or scoped to `a3-g58-workerqueue`)
  - `AmazonECSReadOnlyAccess` (or scoped to `g57-cluster`)
  - `CloudWatchPutMetricDataAccess` (custom policy)
  - `CloudWatchLogsFullAccess` (write logs)
- Trust Policy: Allow Lambda service to assume role

### Security Best Practices

1. **Least Privilege**: IAM policies scoped to specific resources (not `*`)
2. **Private Subnets**: ECS workers in private subnets, NAT gateway for outbound
3. **Security Groups**: Restrict ingress (ALB → EC2 on 8000, VPC → ElastiCache on 11211)
4. **Encryption at Rest**: S3 (SSE-S3), DynamoDB (AWS managed key), Secrets Manager (KMS)
5. **Encryption in Transit**: HTTPS (ALB → EC2), TLS (API → S3/DynamoDB/SQS)
6. **JWT Verification**: `aws-jwt-verify` validates signature, expiry, issuer, audience
7. **Presigned URLs**: Time-limited (60 min), no credentials in client
8. **Secrets Rotation**: Automatic rotation (Secrets Manager) for sensitive credentials
9. **Audit Logs**: CloudTrail (API calls), CloudWatch Logs (application logs)

---

## Monitoring & Observability

### CloudWatch Logs

**Log Groups**:
- `/ecs/g57-api`: API server logs (Express access logs, error logs)
- `/ecs/g57-worker`: Worker logs (FFmpeg stdout/stderr, job processing)
- `/aws/lambda/g58-lambda-customscaling`: Lambda metrics collector logs

**Log Retention**: 7 days (configurable)

**Log Insights Queries**:
```sql
-- API errors (5xx)
fields @timestamp, @message
| filter @message like /5\d{2}/
| sort @timestamp desc
| limit 100

-- Worker failures
fields @timestamp, @message
| filter @message like /status=failed/
| sort @timestamp desc
| limit 100

-- Cache hit rate
fields @timestamp, @message
| filter @message like /CACHE_HIT/ or @message like /CACHE_MISS/
| stats count(*) by @message
```

### CloudWatch Metrics

**API Tier**:
- `AWS/ApplicationELB`: `TargetResponseTime`, `UnHealthyHostCount`, `RequestCount`, `HTTPCode_Target_4XX`, `HTTPCode_Target_5XX`
- `AWS/EC2`: `CPUUtilization`, `NetworkIn`, `NetworkOut`, `StatusCheckFailed`

**Worker Tier**:
- `CAB432/VideoTranscoding`: `BacklogPerWorker` (custom), `QueueVisible`, `QueueNotVisible`, `RunningWorkerTasks`
- `AWS/ECS`: `CPUUtilization`, `MemoryUtilization`, `RunningTaskCount`

**Queue**:
- `AWS/SQS`: `ApproximateNumberOfMessages`, `ApproximateAgeOfOldestMessage`, `NumberOfMessagesSent`, `NumberOfMessagesDeleted`

**DLQ**:
- `AWS/SQS`: `ApproximateNumberOfMessages` (alarm if > 0)

**Cache**:
- `AWS/ElastiCache`: `EngineCPUUtilization`, `CurrConnections`, `Evictions`, `BytesUsedForCache`

### CloudWatch Alarms

**High DLQ Depth**:
- Metric: `AWS/SQS` `ApproximateNumberOfMessages` (DLQ)
- Threshold: > 0
- Evaluation: 1 period of 5 minutes
- Action: SNS notification to admin email

**API Unhealthy Hosts**:
- Metric: `AWS/ApplicationELB` `UnHealthyHostCount`
- Threshold: >= 1
- Evaluation: 2 consecutive periods of 1 minute
- Action: SNS notification to on-call engineer

**High Backlog**:
- Metric: `CAB432/VideoTranscoding` `BacklogPerWorker`
- Threshold: > 10
- Evaluation: 3 consecutive periods of 1 minute
- Action: SNS notification (potential worker bottleneck)

### CloudWatch Dashboard

**Widgets**:
1. **API Health**: ALB TargetResponseTime, RequestCount, HTTPCode_Target_5XX
2. **Worker Health**: BacklogPerWorker, RunningWorkerTasks, ECS CPUUtilization
3. **Queue Depth**: SQS ApproximateNumberOfMessages, ApproximateAgeOfOldestMessage
4. **DLQ Depth**: SQS ApproximateNumberOfMessages (DLQ)
5. **Cache Performance**: ElastiCache EngineCPUUtilization, Evictions

---

## Deployment Strategy

### Rolling Deployment (EC2 API)

**Instance Refresh**:
1. Create new Launch Template version with updated Docker image tag
2. Update Auto Scaling Group to use new Launch Template version
3. Start Instance Refresh:
   - `MinHealthyPercentage`: 90% (maintain 9/10 instances healthy)
   - `InstanceWarmup`: 300s (time for new instance to pass health check)
4. Auto Scaling Group:
   - Launches new instance with updated image
   - Waits for health check to pass (ALB `/api/v1/health`)
   - Drains connections from old instance (300s)
   - Terminates old instance
   - Repeats until all instances replaced

**Benefits**:
- Zero downtime (always 90% capacity available)
- Automatic rollback on health check failures
- Gradual rollout reduces blast radius

### Blue/Green Deployment (ECS Worker)

**Process**:
1. Register new ECS Task Definition revision with updated Docker image tag
2. Update ECS Service with new Task Definition:
   - `ForceNewDeployment`: true
   - `MinimumHealthyPercent`: 100 (don't kill old tasks until new tasks healthy)
   - `MaximumPercent`: 200 (launch new tasks in parallel)
3. ECS Service:
   - Launches new tasks with updated image
   - Waits for tasks to become healthy (container passes health check)
   - Drains old tasks (stop polling SQS, finish current job)
   - Terminates old tasks
4. If new tasks fail health check, ECS automatically rolls back to previous Task Definition

**Benefits**:
- Zero job loss (workers finish current job before termination)
- Automatic rollback on failures
- No manual coordination required

---

## Conclusion

This architecture demonstrates **production-grade**, **cloud-native** design principles:

- **Decoupling**: SQS separates API from workers, enabling independent scaling and fault isolation
- **Auto-Scaling**: Custom metrics drive worker scaling, ALB metrics drive API scaling
- **Fault Tolerance**: SQS retries, DLQ isolation, health checks, graceful degradation
- **Statelessness**: All state externalized to AWS services, enabling horizontal scaling
- **Security**: Least privilege IAM, encryption at rest/in transit, JWT verification, presigned URLs
- **Observability**: CloudWatch Logs/Metrics/Alarms/Dashboards provide centralized monitoring

The platform scales from **zero to thousands** of concurrent users and video uploads with **minimal operational overhead**, leveraging managed AWS services for heavy lifting.

For deployment instructions and API documentation, see [README.md](./README.md) and [API_REFERENCE.md](./API_REFERENCE.md).
