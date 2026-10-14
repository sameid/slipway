# Shared foundation for slipway (design 5.4, slimmed down). var.region is
# dedicated to slipway, so this uses what the region already has (the
# default VPC and its subnets) and adds only:
#
#   iam.tf       the deployer instance role, the permissions boundary for app
#                roles, and the Express Mode infrastructure role
#   deployer.tf  the deployer host (deployer + runner under pm2, Caddy) and the
#                CloudFront distribution in front of it
#   alerts.tf    the alerts topic and the region's budget
#   this file    one bucket for release artifacts and the deployer's backups
#
# Secrets and Clerk keys aren't Terraform resources: the dev team creates them
# with the CLI once the values exist (docs/foundation.md). Names are fixed by
# docs/contracts.md.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_vpc" "default" {
  default = true
}

# The deployer lives in one AZ's default subnet; app environments use them all.
data "aws_subnet" "deployer" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = "${local.region}${var.deployer_az_suffix}"
  default_for_az    = true
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  state_bucket = "slipway-tfstate-${local.account_id}"
}

# The bootstrap stack creates the state bucket; reading it here fails fast if
# it hasn't been run in this account.
data "aws_s3_bucket" "state" {
  bucket = local.state_bucket
}

# Release artifacts and the deployer's backups, by prefix:
#   releases/<app>/<sha>/   frontend build and app.yaml of each app release
#   deployer/<version>.tgz  platform releases (deployer, runner, jobs, modules)
# New buckets are private, owner-enforced and encrypted by default.
resource "aws_s3_bucket" "artifacts" {
  bucket = "slipway-artifacts-${local.account_id}"
}
