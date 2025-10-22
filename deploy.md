To test run in local(fastest way), run:
docker compose up --build
Need to do "aws configure sso" to able to sign in to s3



1. docker
AWS_REGION=ap-southeast-2
AWS_ACCOUNT_ID=901444280953
REPO=g57-a2
TAG=v8
ECR_URI=901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/g57-a2

aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com
docker build -t ${REPO}:${TAG} .
docker tag ${REPO}:${TAG} ${ECR_URI}:${TAG}
docker push ${ECR_URI}:${TAG}

2. deploy
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com
docker pull ${ECR_URI}:${TAG}
docker run -d   --name g57-a2   --restart unless-stopped   -p 80:8000   --env-file .env   ${ECR_URI}:${TAG}


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

SQS queue setup
----------------
1. Create a standard SQS queue (e.g. `cab432-transcode-jobs`) and note its URL.
2. (Optional) Create a dead-letter queue and attach it with an appropriate redrive policy for future DLQ handling.
3. Grant the API and worker task roles `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, and `sqs:GetQueueAttributes` on the queue.
4. Inject `SQS_QUEUE_URL=<queue-url>` into both the API and worker environments (ECS task definition or `.env`).
5. For scaling, monitor `ApproximateNumberOfMessagesVisible` and attach an ECS Service Auto Scaling policy that adds worker tasks when the queue backlog grows.
