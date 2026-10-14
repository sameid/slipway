output "deployer_url" {
  description = "Plugin API, dashboard and GitHub webhook base URL. Each colleague runs /setup with it in Claude Code."
  value       = "https://${aws_cloudfront_distribution.deployer.domain_name}"
}

output "github_webhook_url" {
  value = "https://${aws_cloudfront_distribution.deployer.domain_name}/webhooks/github"
}

output "deployer_instance_id" {
  description = "For Session Manager: aws ssm start-session --target <id>"
  value       = aws_instance.deployer.id
}

output "deployer_public_ip" {
  description = "The Elastic IP CloudFront connects to. Only CloudFront's ranges may reach it."
  value       = aws_eip.deployer.public_ip
}

output "deployer_distribution_id" {
  value = aws_cloudfront_distribution.deployer.id
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "state_bucket" {
  value = data.aws_s3_bucket.state.bucket
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
