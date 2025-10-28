output "worker_queue_url" {
  description = "Primary worker SQS queue URL"
  value       = aws_sqs_queue.worker_queue.id
}

output "worker_dlq_url" {
  description = "Dead letter queue URL"
  value       = aws_sqs_queue.worker_dlq.id
}

output "lambda_function_name" {
  description = "Name of the custom scaling Lambda"
  value       = aws_lambda_function.custom_metric.function_name
}

output "ecs_service_name" {
  description = "Deployed ECS worker service"
  value       = aws_ecs_service.worker.name
}

output "service_discovery_hostname" {
  description = "Cloud Map DNS name for the worker service"
  value       = "${aws_service_discovery_service.worker.name}.${aws_service_discovery_private_dns_namespace.app.name}"
}

output "ssm_prefix" {
  description = "Parameter Store prefix for application configuration"
  value       = local.ssm_prefix
}
