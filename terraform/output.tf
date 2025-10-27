output "worker_queue_url" {
  description = "Primary worker SQS queue URL"
  value       = aws_sqs_queue.worker_queue.id
}

output "worker_dlq_url" {
  description = "Dead letter queue URL"
  value       = aws_sqs_queue.worker_dlq.id
}

output "lambda_function_name" {
  description = "Name of the S3 upload dispatch Lambda"
  value       = aws_lambda_function.s3_dispatch.function_name
}

output "ecs_service_name" {
  description = "Deployed ECS worker service"
  value       = aws_ecs_service.worker.name
}

output "ssm_prefix" {
  description = "Parameter Store prefix for application configuration"
  value       = local.ssm_prefix
}
