terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.23, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # `slipway setup` passes the bucket (slipway-tfstate-<account>) and region:
  #   terraform init -backend-config=bucket=... -backend-config=region=...
  backend "s3" {
    key          = "foundation/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  # Foundation resources never carry an `app` tag: the deployer's CloudFront
  # permissions only reach distributions that have one (iam.tf).
  default_tags {
    tags = {
      platform  = "slipway"
      component = "foundation"
    }
  }
}
