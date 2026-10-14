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

# publishableKey from the environment's Clerk secret (slipway/clerk/stage or
# slipway/clerk/production), read by deploy-env. Public: it ships to browsers
# in config.json.
variable "clerk_publishable_key" {
  type    = string
  default = ""

  validation {
    condition     = var.clerk_publishable_key == "" || startswith(var.clerk_publishable_key, "pk_")
    error_message = "clerk_publishable_key must be a Clerk publishable key (pk_...)."
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
