# All strings, so deploy-env.sh can read them with `terraform output -raw`.

output "app_url" {
  value = local.create_service ? "https://${aws_cloudfront_distribution.web[0].domain_name}" : ""
}

output "service_url" {
  value = local.create_service ? "https://${local.express_host}" : ""
}

output "service_name" {
  value = local.create_service ? aws_ecs_express_gateway_service.api[0].service_name : ""
}

# What the service runs. Phase 1 of the next deploy reads these back so the
# running service is left alone while the migration runs.
output "service_image" {
  value = var.service_image
}

output "release" {
  value = var.release
}

output "deploy_id" {
  value = var.deploy_id
}

output "migrate_image" {
  value = var.migrate_image
}

# The custom domain applied, if any; the prod destroy re-apply passes it back.
output "custom_domain" {
  value = var.custom_domain
}

output "certificate_arn" {
  value = var.certificate_arn
}

output "migrate_task_definition_arn" {
  value = local.create_migrate ? aws_ecs_task_definition.migrate[0].arn : ""
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "subnet_ids" {
  value = join(",", local.subnet_ids)
}

output "task_security_group_id" {
  value = aws_security_group.task.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}

output "distribution_id" {
  value = local.create_service ? aws_cloudfront_distribution.web[0].id : ""
}

output "log_group_name" {
  value = data.aws_cloudwatch_log_group.app.name
}

output "env" {
  value = var.env
}

# The app.yaml-derived inputs, JSON-encoded. Teardown re-applies with exactly
# these, so lifting deletion protection never also resizes the database.
output "inputs" {
  value = jsonencode({
    size              = var.size
    api_port          = var.api_port
    health_check_path = var.health_check_path
    migrate_command   = var.migrate_command
    secret_names      = var.secret_names
  })
}
