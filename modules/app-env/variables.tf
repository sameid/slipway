terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.23, < 7.0" # aws_ecs_express_gateway_service
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6, < 4.0"
    }
  }
}

# ---------------------------------------------------------------------------
# From app.yaml (rendered into the root config by jobs/appyaml.mjs)
# ---------------------------------------------------------------------------

variable "app" {
  type = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.app))
    error_message = "app must be 3-20 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen."
  }
}

variable "env" {
  type = string

  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "size" {
  type    = string
  default = "small"

  validation {
    condition     = contains(["small", "medium", "large"], var.size)
    error_message = "size must be small, medium or large."
  }
}

variable "api_port" {
  type    = number
  default = 3000
}

variable "health_check_path" {
  type    = string
  default = "/api/health"
}

variable "migrate_command" {
  type    = list(string)
  default = ["node", "dist/migrate.js"]
}

# Names declared under secrets: in app.yaml. Values live in /apps/<app>/<env>/<KEY>.
variable "secret_names" {
  type    = list(string)
  default = []
}

# ---------------------------------------------------------------------------
# Set per phase by deploy-env (design 5.6)
# ---------------------------------------------------------------------------

# Full image reference (<repo>@sha256:...). Empty: no service and no CloudFront yet.
variable "service_image" {
  type    = string
  default = ""
}

# Image the migrate task runs. Empty: no migrate task definition yet.
variable "migrate_image" {
  type    = string
  default = ""
}

# Short commit SHA of the release the service runs (container RELEASE).
variable "release" {
  type    = string
  default = ""
}

# The deployer job that last switched the service. A new value starts new
# tasks even when the image is unchanged, e.g. after a secret was set.
variable "deploy_id" {
  type    = string
  default = ""
}

# A hostname someone added on the dashboard (e.g. loans.example.com) and the
# ACM certificate in us-east-1 the deployer got for it. Both or neither. Every
# deploy passes what the deployer has, so leaving them out detaches the domain.
variable "custom_domain" {
  type    = string
  default = ""

  validation {
    condition     = var.custom_domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.custom_domain))
    error_message = "custom_domain must be a lowercase hostname, like loans.example.com."
  }
}

variable "certificate_arn" {
  type    = string
  default = ""

  validation {
    condition     = (var.certificate_arn == "") == (var.custom_domain == "")
    error_message = "custom_domain and certificate_arn go together: set both or neither."
  }
  validation {
    condition     = var.certificate_arn == "" || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate in us-east-1, which is where CloudFront looks."
  }
}

# Set by deploy-env just before terraform destroy: lifts prod's deletion
# protection and gives its final snapshot a unique name.
variable "destroying" {
  type    = bool
  default = false
}

variable "db_engine_version" {
  type    = string
  default = "17"
}
