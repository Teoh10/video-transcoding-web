variable "aws_region" {
  description = "AWS region to deploy resources into"
  type        = string
  default     = "ap-southeast-2"
}

variable "qut_username" {
  description = "QUT username for tagging resources"
  type        = string
}

variable "worker_queue_name" {
  description = "Name for the worker SQS queue"
  type        = string
  default     = "a3-g58-workerqueue"
}

variable "sqs_visibility_timeout" {
  description = "Visibility timeout in seconds for worker queue"
  type        = number
  default     = 900
}

variable "sqs_max_receive_count" {
  description = "Maximum receives before messages go to the DLQ"
  type        = number
  default     = 5
}

variable "queue_high_threshold" {
  description = "Messages visible threshold before scaling out"
  type        = number
  default     = 8
}

variable "queue_low_threshold" {
  description = "Messages visible threshold before scaling in"
  type        = number
  default     = 2
}

variable "hf_image_model" {
  description = "Default Hugging Face model identifier"
  type        = string
  default     = "google/vit-base-patch16-224-in21k"
}

variable "jwt_expires" {
  description = "JWT expiry duration (string)"
  type        = string
  default     = "1800s"
}

variable "tags_min_score" {
  description = "Minimum confidence score for generated tags"
  type        = string
  default     = "0.4"
}

variable "tags_top_k" {
  description = "Number of top tags to keep"
  type        = number
  default     = 5
}

variable "transcode_lock_ttl_ms" {
  description = "Lock TTL for transcode jobs in milliseconds"
  type        = number
  default     = 300000
}

variable "worker_image" {
  description = "ECR image URI for the transcode worker"
  type        = string
}

variable "ecs_execution_role_arn" {
  description = "IAM execution role ARN for ECS tasks"
  type        = string
}

variable "ecs_task_role_arn" {
  description = "IAM task role ARN for ECS tasks"
  type        = string
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster running the worker"
  type        = string
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster (used for autoscaling resource id)"
  type        = string
}

variable "ecs_service_name" {
  description = "Name of the ECS service to create"
  type        = string
  default     = "g58-worker-task-service-uf5324mq"
}

variable "worker_desired_count" {
  description = "Baseline number of worker tasks"
  type        = number
  default     = 1
}

variable "worker_min_count" {
  description = "Minimum autoscaling count"
  type        = number
  default     = 1
}

variable "worker_max_count" {
  description = "Maximum autoscaling count"
  type        = number
  default     = 6
}

variable "worker_task_cpu" {
  description = "CPU units for the worker task definition"
  type        = number
  default     = 1024
}

variable "worker_task_memory" {
  description = "Memory (MiB) for the worker task definition"
  type        = number
  default     = 2048
}

variable "worker_subnet_ids" {
  description = "Subnets for worker tasks (private recommended)"
  type        = list(string)
}

variable "worker_security_group_id" {
  description = "Security group for worker tasks"
  type        = string
}

variable "worker_assign_public_ip" {
  description = "Whether worker tasks should have public IPs"
  type        = bool
  default     = false
}

variable "worker_container_port" {
  description = "Container port exposed by the worker service (for service discovery)"
  type        = number
  default     = 3000
}

variable "worker_cpu_target" {
  description = "CPU percentage target for ECS autoscaling"
  type        = number
  default     = 60
}

variable "vpc_id" {
  description = "VPC ID where ECS tasks run (needed for Cloud Map namespace)"
  type        = string
}

variable "custom_metric_namespace" {
  description = "CloudWatch namespace for custom backlog metrics"
  type        = string
  default     = "Custom/g58/Transcode"
}

variable "worker_count_baseline" {
  description = "Fallback worker count used by the Lambda when ECS describe fails"
  type        = number
  default     = 1
}
