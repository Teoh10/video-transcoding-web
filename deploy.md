To test run in local(fastest way), run:
docker compose up --build
Need to do "aws configure sso" to able to sign in to s3



1. docker-app
AWS_REGION=ap-southeast-2
AWS_ACCOUNT_ID=901444280953
REPO=g58-a3
TAG=v5
ECR_URI=901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g58-a3

docker-worker
AWS_REGION=ap-southeast-2
AWS_ACCOUNT_ID=901444280953
REPO=g58-worker
TAG=v1
ECR_URI=901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g58-worker

aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com
docker build -t ${REPO}:${TAG} .
docker build -f Dockerfile.worker -t ${REPO}:${TAG} .
docker tag ${REPO}:${TAG} ${ECR_URI}:${TAG}
docker push ${ECR_URI}:${TAG}

2. deploy
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com
docker pull ${ECR_URI}:${TAG}
docker run -d   --name g58-a3   --restart unless-stopped   -p 80:8000   --env-file .env   ${ECR_URI}:${TAG}


3. to test.
for the caching, run :
memcflush --server="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"
memcdump --servers="g57-memcache.km2jzi.cfg.apse2.cache.amazonaws.com:11211"

it shows something that mean it is the cache
thumb:user/.../videos/.../thumbnail.jpg:v0
👉 These are binary thumbnail images cached from S3 (JPEGs).
videos:list:c93eb4a8-5091-7039-cb90-5408488a9de5:v1:p3:n6:s-created_at|s:|t:|q:
👉 This is the video list metadata cache entry.


for s3 just open the aws and show the s3 bucket name and video files
for dynamo. open the dynamo table and show some table items

dns just open the url just the dns name



Terraform

1) Go to this link to download https://developer.hashicorp.com/terraform/install
2) Create a folder called terraform, add three files, main.tf, output.tf and version.tf
3) run the code below to create 

##### Must cd into terraform folder first
terraform init
terraform fmt
terraform validate
terraform plan -out tfplan
terraform apply tfplan

terraform destroy # if want





#####################
AWS_REGION: used so the app knows which AWS region to talk to.

PORT: tells the Express server which port to listen on.

JWT_EXPIRES: sets how long login tokens remain valid.

HF_IMAGE_MODEL: stores which HuggingFace image model to call for video topic detection.

TAGS_TOP_K / TAGS_MIN_SCORE: configure filtering thresholds for auto-generated tags.

QUT_USERNAME: identifies the student for marking.

TRANSCODE_LOCK_TTL_MS: timeout for distributed locking of video transcoding jobs.
To launch the API microservice locally (without the worker), run `npm run api` or `docker compose up app`.

## Autoscaling With Custom Metric

The Lambda source for the custom scaling metric lives at `lambda/transcode-metrics/index.mjs`. It reads the queue depth from SQS, the running task count from ECS, and publishes `BacklogPerWorker` plus helper metrics to CloudWatch so the worker service scales on backlog instead of CPU.

### Deploy the Lambda
- Zip the file: `zip -j lambda.zip lambda/transcode-metrics/index.mjs`.
- Create the function (Node.js 20) with an execution role that can read the SSM parameter `/cab432/g57/app/SQS_QUEUE_URL`, call `sqs:GetQueueAttributes`, `cloudwatch:PutMetricData`, and (optionally) `ecs:DescribeServices` if the role can inspect the ECS service.
- Set environment variables:
  - `AWS_REGION=ap-southeast-2`
  - `PARAMETER_STORE_PREFIX=/cab432/g57/app/`
  - `SQS_QUEUE_PARAM_KEY=SQS_QUEUE_URL`
  - `WORKER_COUNT_BASELINE=1` (fallback when ECS permissions are not available)
  - Optional: `ECS_CLUSTER_NAME=a3-g58-worker-microservice`, `ECS_SERVICE_NAME=a3-g58-worker-microservice`
  - Optional: `CUSTOM_METRIC_NAMESPACE=Custom/g58/Transcode`

### Schedule the Metric Publisher
- Create an EventBridge rule (e.g. `rate(1 minute)`) that invokes the Lambda.
- Verify the Lambda logs include the queue URL and backlog statistics.
- In CloudWatch -> Metrics -> `Custom/g58/Transcode`, confirm the new metrics appear.

### Update ECS Scaling Policies
- In the ECS console, open service `a3-g58-worker-microservice`.
- Attach a target-tracking policy on metric `BacklogPerWorker` with target value `2`. Use your existing `g58-SQS-QueueHigh`/`Low` alarms as fallbacks for step scaling if desired.
- Set min/max task counts (e.g. min 1, max 10) and test by pushing messages onto the queue; watch the metric cross the target and trigger scale out/in.

## Lambda: S3 Upload Dispatcher

`lambda/s3-upload-dispatch/index.mjs` is a serverless entry point that reacts to new `original.mp4` uploads and enqueues the matching transcode job on SQS. This avoids wiring EventBridge schedules if your account lacks those permissions.

### Deploy the Dispatcher
- Zip it: `zip -j lambda-s3-dispatch.zip lambda/s3-upload-dispatch/index.mjs`.
- Create a Lambda (Node.js 20) with an execution role that can read `/cab432/g57/app/SQS_QUEUE_URL` from SSM and call `sqs:SendMessage`.
- Configure environment variables:
  - `AWS_REGION=ap-southeast-2`
  - `PARAMETER_STORE_PREFIX=/cab432/g57/app/`
  - `SQS_QUEUE_PARAM_KEY=SQS_QUEUE_URL`
  - Optional: `SQS_QUEUE_URL` (direct value if you prefer not to read Parameter Store)
  - Optional: `EXPECTED_BUCKET_NAME=<your-private-video-bucket>` to filter events from the target bucket only

### Wire the Trigger
- In S3, add an event notification on the bucket (ObjectCreated, suffix `original.mp4`) targeting the Lambda.
- Upload a test video using the standard key pattern `user/<userId>/videos/<videoId>/original.mp4`.
- Verify the Lambda logs the dispatch and an SQS message appears in queue `a3-g58-workerqueue`; the worker service should pick up the job as usual.

## Terraform IaC

- Populate `terraform/terraform.tfvars` (example below) with your AWS-specific values before running Terraform:
  ```hcl
  qut_username             = "n1234567@qut.edu.au"
  upload_bucket            = "g58-transcode-uploads"
  worker_image             = "901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g58-worker:v1"
  ecs_execution_role_arn   = "arn:aws:iam::901444280953:role/cab432-ecs-execution"
  ecs_task_role_arn        = "arn:aws:iam::901444280953:role/cab432-ecs-task"
  ecs_cluster_arn          = "arn:aws:ecs:ap-southeast-2:901444280953:cluster/a3-g58-worker-microservice"
  ecs_cluster_name         = "a3-g58-worker-microservice"
  worker_subnet_ids        = ["subnet-abc", "subnet-def"]
  worker_security_group_id = "sg-123"
  ```
- From the `terraform/` directory run `terraform fmt`, `terraform init`, and `terraform plan -out tfplan`. Inspect the plan to confirm the SQS queue, DLQ, Parameter Store keys, Lambda, and ECS worker service match expectations. Capture a screenshot of the plan for submission.
- Apply in your sandbox account with `terraform apply tfplan`. After the run finishes:
- Check SSM Parameter Store for `/cab432/g57/app/...` values.
  - Verify the Lambda function `g58-s3-upload-dispatch` exists and can enqueue to SQS (trigger it via S3 upload and watch CloudWatch logs/SQS queue).
  - Confirm the ECS service `a3-g58-worker-microservice` is up and tied to the queue; watch the worker scale when queue depth hits the CloudWatch alarms.
