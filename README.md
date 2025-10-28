# CAB432 Video Transcoding Platform

A production-grade, cloud-native video processing platform built with Node.js, Express, and AWS services. The system handles video uploads, transcoding to multiple resolutions, thumbnail generation, and delivers content at scale using a decoupled, auto-scaling architecture.

## 🚀 Quick Start (Local Development)

```bash
# Clone and install
git clone <repository-url>
cd CAB432
npm ci

# Configure AWS credentials
aws configure --profile CAB432-STUDENT-901444280953

# Run with Docker Compose (includes Memcached)
docker-compose up --build

# Or run locally
npm run dev
```

The application will be available at http://localhost:8000

---

## 🏗️ Production Architecture

In production, the platform is deployed as a **decoupled, auto-scaling** system across multiple AWS services:

### Compute Planes

#### API Tier (EC2 + ALB + Auto Scaling)
- **Route 53**: DNS resolution for `g58.cab432.com` → Application Load Balancer
- **Application Load Balancer**: Terminates HTTPS, performs health checks on `/api/v1/health`, distributes traffic across EC2 instances
- **EC2 Auto Scaling Group**: Runs Express API containers, scales based on CPU/ALB metrics
- **Purpose**: Handle user authentication, video metadata CRUD, presigned URL generation, SQS job enqueueing

#### Worker Tier (ECS Fargate + Custom Scaling)
- **Amazon ECS Service**: Runs FFmpeg worker containers on Fargate
- **SQS Queue**: `a3-g58-workerqueue` decouples API from workers
- **Custom Metric Scaling**: EventBridge + Lambda publishes `BacklogPerWorker` metric (queue depth / running tasks) every minute
- **Application Auto Scaling**: Adjusts ECS task count based on `BacklogPerWorker` threshold
- **Purpose**: Process video transcoding jobs asynchronously, independent of API load

### Core AWS Components

| Service | Role | Rationale |
|---------|------|-----------|
| **Route 53** | DNS routing to ALB | Global DNS with health checks, failover support |
| **Application Load Balancer** | HTTPS termination, traffic distribution | Managed TLS certificates, connection draining, health probing |
| **EC2 (API)** | Stateless API serving | Cost-effective for steady traffic, flexible instance types |
| **Auto Scaling (EC2)** | Scale API tier by demand | Match capacity to traffic spikes, reduce over-provisioning |
| **Amazon ECS Fargate** | Container orchestration for workers | No server management, built-in task isolation, pay-per-second billing |
| **SQS Queue + DLQ** | Job decoupling, fault tolerance | Guarantees at-least-once delivery, automatic retries, dead-letter isolation |
| **EventBridge + Lambda** | Custom metrics collection | Scheduled CloudWatch metric publishing for scaling decisions |
| **Application Auto Scaling** | ECS task count adjustment | Scales workers based on queue backlog, ensures timely processing |
| **S3** | Object storage (originals, renditions, thumbnails) | Infinite capacity, presigned URLs offload traffic from API |
| **DynamoDB** | Video metadata, job state | Single-digit ms latency, auto-scaling, single-table design |
| **ElastiCache (Memcached)** | Cache video list queries | Sub-millisecond reads, namespace invalidation strategy |
| **Cognito** | User authentication, JWT issuance | Managed OAuth2, MFA support, group-based authorization |
| **Secrets Manager** | Sensitive credentials (API keys, tokens) | Automatic rotation, encryption at rest, audit logs |
| **SSM Parameter Store** | Non-sensitive config (regions, URLs) | Hierarchical namespacing, version history |
| **CloudWatch** | Logs, metrics, alarms, dashboards | Centralized observability, automated alerting |

**Optional Edge Services**:
- **CloudFront**: CDN for processed videos (low-latency playback)
- **SNS**: Job completion notifications
- **S3 Lifecycle Rules**: Archive old originals to Glacier

### Data Flow: Upload → Transcode → Delivery

```
1. Client → API (EC2):  POST /api/v1/videos (initiate upload)
2. API → DynamoDB:      Create video record (status=queued)
3. API → SQS:           Enqueue transcoding job message
4. API → Client:        Return presigned S3 PUT URL
5. Client → S3:         Upload original.mp4 directly (bypasses API)
6. ECS Worker → SQS:    Poll queue for messages
7. Worker → S3:         Download original.mp4
8. Worker → FFmpeg:     Transcode to 1080p/720p/480p, extract thumbnail
9. Worker → S3:         Upload renditions + thumbnail
10. Worker → DynamoDB:  Update video (status=completed, renditions, duration)
11. Worker → SQS:       Delete message (acknowledge success)
12. Client → API:       GET /api/v1/videos/:id (poll for completion)
13. API → DynamoDB:     Read metadata (cached in ElastiCache)
14. API → Client:       Return presigned S3 GET URLs for streaming
15. Client → S3:        Stream video directly
```

**Failure Handling**:
- SQS retries failed messages up to 3 times (MaxReceiveCount)
- After 3 failures, message moves to Dead Letter Queue (DLQ)
- Worker sets DynamoDB status to `failed` and logs error
- CloudWatch Alarm triggers on DLQ depth > 0

### Scaling Strategy

**API Tier (EC2)**:
- Target Tracking Scaling: Maintain 70% average CPU utilization
- ALB Request Count per Target: Scale out if > 1000 requests/target/minute
- Min: 2 instances (high availability), Max: 10 instances

**Worker Tier (ECS)**:
- Custom Metric: `BacklogPerWorker` = (ApproximateNumberOfMessages + ApproximateNumberOfMessagesNotVisible) / RunningTaskCount
- Target: 2 messages per worker (ensures queue drains within SLA)
- EventBridge rule triggers Lambda every 60 seconds
- Lambda queries SQS queue attributes, ECS service task count → publishes CloudWatch metric
- Application Auto Scaling adjusts ECS desired count
- Min: 1 task (cost optimization), Max: 20 tasks (burst capacity)

---

## ✨ Features

### Core Functionality

- **User Authentication** (AWS Cognito)
  - Registration with email confirmation
  - Login with username/password
  - JWT-based stateless authentication
  - Group-based authorization (Admin group)

- **Video Upload & Management**
  - Direct upload via presigned S3 URLs (client → S3, bypasses API for large files)
  - Video listing with pagination, search, status/tag filtering
  - Single video retrieval with ETag caching
  - Cancel in-progress transcodes
  - Admin-only video deletion

- **Automated Transcoding Pipeline**
  - ECS workers poll SQS queue for jobs
  - Transcodes to 1080p, 720p, 480p using FFmpeg
  - Generates thumbnail at 3-second mark
  - Updates DynamoDB with renditions, thumbnail, duration
  - Handles failures with automatic retries (SQS) and DLQ isolation
  - Supports graceful cancellation via AbortController

- **Media Delivery**
  - Presigned S3 URLs for streaming and downloading
  - Resolution selection (original, 1080p, 720p, 480p)
  - Thumbnail serving with fallback SVG placeholder

- **Caching** (AWS ElastiCache / Memcached)
  - Namespace-based cache invalidation for video lists
  - Automatic cache warming on queries
  - Graceful degradation if cache is unavailable

### Cloud Services Integration

- **AWS Cognito**: User pool, JWT verification, MFA support
- **Amazon S3**: Private bucket, presigned URLs for secure access
- **Amazon DynamoDB**: Single-table design for video metadata, job queue
- **Amazon SQS**: Decoupled job queue with DLQ for poison messages
- **Amazon ECS**: Fargate-based worker orchestration with auto-scaling
- **AWS Secrets Manager**: Secure storage for API keys, tokens
- **AWS Systems Manager Parameter Store**: Non-sensitive configuration
- **AWS ElastiCache (Memcached)**: In-memory cache for hot queries
- **AWS EventBridge + Lambda**: Custom metric collection for scaling
- **AWS CloudWatch**: Centralized logging, metrics, alarms, dashboards

---

## 📚 Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: Detailed system design, data flows, scaling strategies, and deployment architecture
- **[API_REFERENCE.md](./API_REFERENCE.md)**: Complete REST API documentation with request/response schemas

---

## 🔧 Environment Setup

### Prerequisites

**Local Development**
- Node.js 20 LTS
- FFmpeg installed and available on PATH
- AWS CLI configured with `CAB432-STUDENT-901444280953` profile
- AWS account access (Cognito, S3, DynamoDB, Secrets Manager, SSM, ElastiCache)

**Docker Development**
- Docker Desktop
- AWS CLI configured for credential mounting

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

**Note**: Sensitive values (Cognito secrets, API tokens) are loaded from **AWS Secrets Manager** at runtime. Non-sensitive config (region, model names, TTLs) comes from **SSM Parameter Store**.

### Local Development

**Option 1: Docker Compose (Recommended)**
```bash
# Build and start (includes local Memcached)
docker-compose up --build

# Run detached
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop
docker-compose down
```

**Option 2: Node.js**
```bash
# Install dependencies
npm ci

# Ensure AWS credentials are configured
aws configure list-profiles  # Should show CAB432-STUDENT-901444280953

# Start server (with local worker)
npm run dev
```

Open http://localhost:8000

---

## 🚢 Production Deployment

### Prerequisites

1. **AWS Resources Provisioned** (via Terraform or manually):
   - VPC with public/private subnets
   - ALB with HTTPS listener (ACM certificate)
   - Target Group for EC2 instances
   - EC2 Auto Scaling Group with Launch Template
   - ECS Cluster + Task Definition + Service
   - SQS Queue + Dead Letter Queue
   - S3 Bucket (private, versioning enabled)
   - DynamoDB Table (pay-per-request billing)
   - ElastiCache Memcached cluster
   - Cognito User Pool + App Client
   - Secrets Manager secret
   - SSM Parameter Store parameters
   - EventBridge rule + Lambda for custom metrics
   - CloudWatch Log Groups, Alarms, Dashboard
   - IAM roles for EC2, ECS, Lambda

2. **ECR Repository**: `<account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2`

3. **Route 53 Hosted Zone**: Domain configured with CNAME → ALB DNS

### Step 1: Build and Push Docker Images

**API Image** (runs on EC2):
```bash
# Login to ECR
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com

# Build API image
docker build -t g57-a2:v8 -f Dockerfile .

# Tag and push
docker tag g57-a2:v8 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2:v8
docker push 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2:v8
```

**Worker Image** (runs on ECS):
```bash
# Build worker image
docker build -t g57-a2-worker:v8 -f Dockerfile.worker .

# Tag and push
docker tag g57-a2-worker:v8 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2-worker:v8
docker push 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2-worker:v8
```

### Step 2: Deploy API to EC2

**Update Launch Template** (AWS Console or CLI):
```bash
# Create new Launch Template version
aws ec2 create-launch-template-version \
  --launch-template-id lt-xxx \
  --version-description "API v8" \
  --source-version $LATEST \
  --launch-template-data '{
    "ImageId": "ami-0c55b159cbfafe1f0",
    "InstanceType": "t3.medium",
    "IamInstanceProfile": {"Arn": "arn:aws:iam::901444280953:instance-profile/g57-ec2-api-role"},
    "SecurityGroupIds": ["sg-xxx"],
    "UserData": "<base64-encoded-user-data>"
  }'
```

**User Data Script** (Base64 encode this):
```bash
#!/bin/bash
# Install Docker
yum install -y docker
systemctl enable docker --now

# Login to ECR
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com

# Pull and run API container
docker pull 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2:v8
docker run -d \
  --name g57-api \
  --restart unless-stopped \
  -p 8000:8000 \
  -e AWS_REGION=ap-southeast-2 \
  -e MEMCACHED_ENDPOINT=g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211 \
  901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2:v8
```

**Update Auto Scaling Group**:
```bash
# Set new Launch Template version
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name g57-api-asg \
  --launch-template LaunchTemplateId=lt-xxx,Version='$Latest'

# Perform instance refresh (rolling deployment)
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name g57-api-asg \
  --preferences '{"MinHealthyPercentage": 90, "InstanceWarmup": 300}'
```

### Step 3: Deploy Workers to ECS

**Update ECS Task Definition**:
```bash
# Register new task definition revision
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

**task-definition.json**:
```json
{
  "family": "g57-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::901444280953:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::901444280953:role/g57-ecs-worker-role",
  "containerDefinitions": [
    {
      "name": "worker",
      "image": "901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2-worker:v8",
      "essential": true,
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

**Update ECS Service**:
```bash
# Deploy new task definition to service
aws ecs update-service \
  --cluster g57-cluster \
  --service g57-worker-service \
  --task-definition g57-worker:8 \
  --force-new-deployment
```

### Step 4: Configure Custom Scaling

**EventBridge Rule** (already created, triggers Lambda every minute):
```bash
aws events put-rule \
  --name g57-scaling-metrics \
  --schedule-expression "rate(1 minute)" \
  --state ENABLED
```

**Lambda Function** (publishes `BacklogPerWorker` metric):
```javascript
// lambda/transcode-metrics/index.mjs
export const handler = async (event) => {
  const sqs = new SQSClient({region: 'ap-southeast-2'});
  const ecs = new ECSClient({region: 'ap-southeast-2'});
  const cloudwatch = new CloudWatchClient({region: 'ap-southeast-2'});
  
  // Get queue depth
  const queueAttrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: process.env.QUEUE_URL,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
  }));
  
  const visible = parseInt(queueAttrs.Attributes.ApproximateNumberOfMessages);
  const notVisible = parseInt(queueAttrs.Attributes.ApproximateNumberOfMessagesNotVisible);
  
  // Get running tasks
  const service = await ecs.send(new DescribeServicesCommand({
    cluster: process.env.CLUSTER_NAME,
    services: [process.env.SERVICE_NAME]
  }));
  
  const runningCount = service.services[0].runningCount || 1;
  const backlogPerWorker = (visible + notVisible) / runningCount;
  
  // Publish metrics
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'CAB432/VideoTranscoding',
    MetricData: [
      {MetricName: 'QueueVisible', Value: visible, Unit: 'Count'},
      {MetricName: 'QueueNotVisible', Value: notVisible, Unit: 'Count'},
      {MetricName: 'RunningWorkerTasks', Value: runningCount, Unit: 'Count'},
      {MetricName: 'BacklogPerWorker', Value: backlogPerWorker, Unit: 'Count'}
    ]
  }));
};
```

**Application Auto Scaling Policy**:
```bash
# Register ECS service as scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/g57-cluster/g57-worker-service \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 \
  --max-capacity 20

# Create target tracking scaling policy
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id service/g57-cluster/g57-worker-service \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name backlog-per-worker-policy \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 2.0,
    "CustomizedMetricSpecification": {
      "MetricName": "BacklogPerWorker",
      "Namespace": "CAB432/VideoTranscoding",
      "Statistic": "Average"
    },
    "ScaleOutCooldown": 60,
    "ScaleInCooldown": 300
  }'
```

### Step 5: Verify Deployment

**Check API Health**:
```bash
curl https://g58.cab432.com/api/v1/health
# Expected: {"status":"healthy","timestamp":"..."}
```

**Check ECS Service**:
```bash
aws ecs describe-services --cluster g57-cluster --services g57-worker-service
# Check desiredCount, runningCount, deployments
```

**Monitor Logs**:
```bash
# API logs (CloudWatch)
aws logs tail /ecs/g57-api --follow

# Worker logs
aws logs tail /ecs/g57-worker --follow
```

**Test Upload**:
1. Open https://g58.cab432.com
2. Register/login
3. Upload video
4. Monitor SQS queue: `aws sqs get-queue-attributes --queue-url <url> --attribute-names All`
5. Watch ECS scale: `aws ecs describe-services ...`
6. Check CloudWatch metrics: `BacklogPerWorker`, `RunningWorkerTasks`

---

## 🧪 Testing

### DLQ Testing (Simulate Worker Failure)

```bash
# 1. Start local environment
docker-compose up --build

# 2. Stop worker (in separate terminal)
docker-compose stop worker

# 3. Upload video via UI

# 4. Find VIDEO_ID in logs
docker-compose logs app | grep "enqueued video"
# Copy <VIDEO_ID>

# 5. Delete S3 original file (simulate missing file)
aws s3 rm s3://g57-bucket/user/<USER_ID>/videos/<VIDEO_ID>/original.mp4

# 6. Restart worker
docker-compose logs -f worker
docker-compose start worker

# Worker will fail 3 times (NoSuchKey error), message moves to DLQ
```

**Verify DLQ**:
```bash
# Check DLQ message count
aws sqs get-queue-attributes \
  --queue-url https://sqs.ap-southeast-2.amazonaws.com/901444280953/a3-g58-workerqueue-dlq \
  --attribute-names ApproximateNumberOfMessages

# Receive DLQ message
aws sqs receive-message \
  --queue-url https://sqs.ap-southeast-2.amazonaws.com/901444280953/a3-g58-workerqueue-dlq \
  --max-number-of-messages 1
```

### Caching Verification

```bash
# Flush cache
memcflush --servers="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"

# Check cache keys
memcdump --servers="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"

# Example keys:
# - videos:list:c93eb4a8-5091-7039-cb90-5408488a9de5:v1:p3:n6:s-created_at|s:|t:|q:
# - thumb:user/.../videos/.../thumbnail.jpg:v0
```

**Cache Hit/Miss Logs**:
```bash
docker-compose logs app | grep "CACHE"
# [cache] CACHE_HIT for videos:list:...
# [cache] CACHE_MISS for videos:list:...
```

---

## 📊 Monitoring & Observability

### CloudWatch Dashboard

Key metrics to monitor:
- **API Tier**: ALB TargetResponseTime, UnHealthyHostCount, RequestCount, HTTPCode_Target_4XX/5XX
- **Worker Tier**: BacklogPerWorker, RunningWorkerTasks, ECS CPUUtilization, MemoryUtilization
- **Queue**: SQS ApproximateNumberOfMessages, ApproximateAgeOfOldestMessage
- **DLQ**: ApproximateNumberOfMessages (alarm if > 0)
- **Cache**: ElastiCache EngineCPUUtilization, CurrConnections, Evictions

### CloudWatch Alarms

**High DLQ Depth**:
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name g57-dlq-depth \
  --metric-name ApproximateNumberOfMessages \
  --namespace AWS/SQS \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator GreaterThanThreshold \
  --dimensions Name=QueueName,Value=a3-g58-workerqueue-dlq
```

**API Unhealthy Hosts**:
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name g57-api-unhealthy-hosts \
  --metric-name UnHealthyHostCount \
  --namespace AWS/ApplicationELB \
  --statistic Average \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold
```

---

## 🛠️ Troubleshooting

### Common Issues

**1. Docker Build: "invalid file request"**
- **Cause**: OneDrive cloud-only file storage
- **Fix**: Right-click workspace folder → "Always keep on this device"

**2. Video upload fails locally**
- **Cause**: `DB_FILE=./data/app.db` resolves differently inside Docker
- **Fix**: Use absolute path or volume mount

**3. Worker not scaling**
- **Cause**: EventBridge rule disabled or Lambda failing
- **Fix**: Check Lambda logs, verify IAM permissions for SQS/ECS/CloudWatch

**4. High DLQ depth**
- **Cause**: S3 keys don't match, network issues, FFmpeg errors
- **Fix**: Check worker logs, inspect DLQ message body, replay message after fix

**5. Cache misses on every request**
- **Cause**: ElastiCache security group blocks port 11211
- **Fix**: Add inbound rule for port 11211 from API security group

---

## 📦 Project Structure

```
CAB432/
├── public/                    # Static frontend (HTML/JS/CSS)
│   ├── index.html            # Landing page
│   ├── login.html            # Login/signup forms
│   ├── confirm.html          # Email confirmation
│   └── *.js, style.css       # Client-side logic
├── src/
│   ├── index.js              # Express app bootstrap
│   ├── api/service.js        # Main server (production, no worker)
│   ├── routes/               # API endpoints
│   │   ├── auth.js           # Cognito signup/login
│   │   ├── videos.js         # Video CRUD + job enqueueing
│   │   ├── media.js          # Presigned URLs for streaming
│   │   └── me.js             # User profile
│   ├── worker/               # ECS worker components
│   │   ├── service.js        # Worker-only entry point
│   │   └── transcodeWorker.js # SQS polling + FFmpeg
│   ├── lib/
│   │   ├── cache.js          # Memcached client
│   │   ├── ffmpeg.js         # FFmpeg wrapper
│   │   ├── paths.js          # DynamoDB repository
│   │   ├── s3Presign.js      # S3 presigned URL generation
│   │   ├── sqs.js            # SQS send/receive helpers
│   │   └── upload.js         # Multipart upload handler
│   ├── config/
│   │   ├── parameterStore.js # SSM Parameter Store loader
│   │   └── secretManager.js  # Secrets Manager loader
│   └── middleware/
│       └── auth.js           # Cognito JWT verification
├── lambda/                   # Lambda functions
│   ├── s3-upload-dispatch/   # (Unused) S3 event trigger
│   └── transcode-metrics/    # Custom scaling metrics collector
├── terraform/                # Infrastructure as Code
│   ├── main.tf               # VPC, ALB, EC2, ECS, SQS, DynamoDB, etc.
│   ├── variables.tf          # Input variables
│   ├── outputs.tf            # Output values (ALB DNS, etc.)
│   └── terraform.tfvars      # Variable values
├── Dockerfile                # API container (for EC2)
├── Dockerfile.worker         # Worker container (for ECS)
├── docker-compose.yml        # Local dev environment (app + memcached)
├── package.json              # Node.js dependencies
├── README.md                 # This file
├── ARCHITECTURE.md           # Detailed architecture documentation
└── API_REFERENCE.md          # API endpoint documentation
```

---

## 👥 Team

- **Student ID**: n11547912 (QUT_USERNAME: `group57`)
- **Course**: CAB432 Cloud Computing
- **Semester**: 2024

---

## 📄 License

This project is for educational purposes only (QUT CAB432 Assignment 2).
