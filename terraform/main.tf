provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  project_prefix = "g58"
  ssm_prefix     = "/cab432/g57/app"
}

# ---------------------------
# Service discovery namespace (Cloud Map)
# ---------------------------
resource "aws_service_discovery_private_dns_namespace" "app" {
  name        = "${local.project_prefix}.local"
  description = "Private namespace for ${local.project_prefix} services"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "worker" {
  name = "${local.project_prefix}-worker"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.app.id
    dns_records {
      ttl  = 30
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# ---------------------------
# SQS Queue & Dead Letter Queue
# ---------------------------
resource "aws_sqs_queue" "worker_dlq" {
  name = "a3-g58-workerqueue-dlq"

  tags = {
    qut-username = var.qut_username
    project      = local.project_prefix
  }
}

resource "aws_sqs_queue" "worker_queue" {
  name                       = var.worker_queue_name
  visibility_timeout_seconds = var.sqs_visibility_timeout
  message_retention_seconds  = 1209600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.worker_dlq.arn
    maxReceiveCount     = var.sqs_max_receive_count
  })

  tags = {
    qut-username = var.qut_username
    project      = local.project_prefix
  }
}

# ---------------------------
# CloudWatch Alarms for Queue Length
# ---------------------------
resource "aws_cloudwatch_metric_alarm" "queue_high" {
  alarm_name          = "g58-BackLogHigh"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = var.queue_high_threshold
  dimensions = {
    QueueName = aws_sqs_queue.worker_queue.name
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_low" {
  alarm_name          = "g58-BacklogLow"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = var.queue_low_threshold
  dimensions = {
    QueueName = aws_sqs_queue.worker_queue.name
  }
}

# ---------------------------
# Parameter Store configuration
# ---------------------------
resource "aws_ssm_parameter" "app_parameters" {
  for_each = {
    AWS_REGION             = var.aws_region
    HF_IMAGE_MODEL         = var.hf_image_model
    JWT_EXPIRES            = var.jwt_expires
    QUT_USERNAME           = var.qut_username
    SQS_REGION             = var.aws_region
    SQS_VISIBILITY_SECONDS = tostring(var.sqs_visibility_timeout)
    TAGS_MIN_SCORE         = var.tags_min_score
    TAGS_TOP_K             = tostring(var.tags_top_k)
    TRANSCODE_LOCK_TTL_MS  = tostring(var.transcode_lock_ttl_ms)
  }

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "String"
  value = each.value
}

resource "aws_ssm_parameter" "sqs_queue_url" {
  name  = "${local.ssm_prefix}/SQS_QUEUE_URL"
  type  = "String"
  value = aws_sqs_queue.worker_queue.id
}

# ---------------------------
# Lambda: Custom backlog metric publisher
# ---------------------------
data "archive_file" "custom_metric" {
  type        = "zip"
  source_file = "${path.module}/../lambda/transcode-metrics/index.mjs"
  output_path = "${path.module}/lambda-custom-metric.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "lambda_role" {
  name               = "${local.project_prefix}-s3-dispatch-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters"
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "sqs:GetQueueAttributes"
    ]
    resources = [aws_sqs_queue.worker_queue.arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
  }
  statement {
    effect = "Allow"
    actions = [
      "ecs:DescribeServices"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_inline" {
  role   = aws_iam_role.lambda_role.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

resource "aws_lambda_function" "custom_metric" {
  function_name = "g58-lambda-customscaling"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = data.archive_file.custom_metric.output_path
  role          = aws_iam_role.lambda_role.arn

  environment {
    variables = {
      AWS_REGION             = var.aws_region
      PARAMETER_STORE_PREFIX = local.ssm_prefix
      SQS_QUEUE_PARAM_KEY    = "SQS_QUEUE_URL"
      CUSTOM_METRIC_NAMESPACE = var.custom_metric_namespace
      WORKER_COUNT_BASELINE   = tostring(var.worker_count_baseline)
      ECS_CLUSTER_NAME        = var.ecs_cluster_name
      ECS_SERVICE_NAME        = var.ecs_service_name
    }
  }
}

# ---------------------------
# ECS Worker Task Definition & Service
# ---------------------------
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.project_prefix}-worker"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.project_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_task_cpu)
  memory                   = tostring(var.worker_task_memory)
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true
      command   = ["npm", "run", "worker"]
      environment = [
        { name = "USE_PARAMETER_STORE", value = "true" },
        { name = "SQS_QUEUE_URL", value = aws_sqs_queue.worker_queue.id }
      ]
      portMappings = [
        {
          containerPort = var.worker_container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = var.ecs_service_name
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    assign_public_ip = var.worker_assign_public_ip
    subnets          = var.worker_subnet_ids
    security_groups  = [var.worker_security_group_id]
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 50

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.worker.arn
    port           = var.worker_container_port
    container_name = "worker"
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = var.worker_max_count
  min_capacity       = var.worker_min_count
  resource_id        = "service/${var.ecs_cluster_name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_target_tracking" {
  name               = "${local.project_prefix}-backlog-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.worker_cpu_target
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
  }
}
