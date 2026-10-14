# Per-app shared stack (design 5.3): what staging and prod have in common.
# State key apps/<app>/shared.tfstate. Created before the first build, destroyed last.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.23, < 7.0"
    }
  }
}

variable "app" {
  type        = string
  description = "App name (also the GitHub repo name)."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.app))
    error_message = "app must be 3-20 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# One repository for both environments, so a promote deploys the exact digest
# staging ran. Tags are commit SHAs and never move.
resource "aws_ecr_repository" "app" {
  name                 = "app-${var.app}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true # teardown removes the images too

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keeps enough history for rollbacks without paying for every build forever.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the newest 50 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 50
      }
      action = { type = "expire" }
    }]
  })
}

# API and migrate logs for both environments; streams are prefixed <env>/api and <env>/migrate.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/slipway/app-${var.app}"
  retention_in_days = var.log_retention_days
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecr_repository_name" {
  value = aws_ecr_repository.app.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}
