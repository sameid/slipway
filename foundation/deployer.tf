# The deployer host (design 5.5, with the runner from docs/contracts.md): one
# x86_64 instance in a default subnet. pm2 runs the deployer and the runner
# (builds and deploys, so no CodeBuild is needed in any region), each as
# its own user, and rotates their logs; Caddy listens on 8080 for CloudFront.
#
# The instance has a public address, but its security group only lets in
# CloudFront's origin-facing ranges on 8080, and Caddy rejects any request
# without the secret X-Slipway-Origin header this distribution adds, so other
# CloudFront distributions can't reach it either. Viewers get HTTPS from
# CloudFront; the hop from CloudFront to the instance is plain HTTP.
#
# Maintenance is through SSM Session Manager (no SSH). The instance can be
# rebuilt from this file, and its network interface and Elastic IP stay, so
# CloudFront's origin never changes. Its SQLite database lives only on the root
# volume, though: until EBS backups exist, replacing the instance loses the
# deployer's state (accounts, app registry, job history; the apps keep running).

data "aws_ssm_parameter" "al2023_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  # Caddy listens here for CloudFront; the deployer itself only on localhost.
  caddy_port    = 8080
  deployer_port = 3000

  # /etc/slipway/deployer.env and /etc/slipway/runner.env
  # (docs/contracts.md, "Deployer host").
  deployer_env = {
    NODE_ENV              = "production"
    HOST                  = "127.0.0.1"
    PORT                  = local.deployer_port
    AWS_REGION            = local.region
    DATA_DIR              = "/var/lib/slipway"
    GITHUB_OWNER          = var.github_owner
    GITHUB_ALLOWED_USERS  = join(",", var.github_allowed_users)
    GITHUB_CODEOWNERS     = var.github_codeowners
    PUBLIC_URL            = "https://${aws_cloudfront_distribution.deployer.domain_name}"
    RUNNER_SOCKET         = "/run/slipway/runner.sock"
    GITHUB_APP_SECRET_ID  = "slipway/github-app"
    CLERK_LOCAL_SECRET_ID = "slipway/clerk/local"
    ALERTS_TOPIC_ARN      = aws_sns_topic.alerts.arn
  }

  runner_env = {
    NODE_ENV           = "production"
    AWS_REGION         = local.region
    AWS_ACCOUNT_ID     = local.account_id
    RELEASES_BUCKET    = aws_s3_bucket.artifacts.bucket
    STATE_BUCKET       = data.aws_s3_bucket.state.bucket
    RUNNER_SOCKET      = "/run/slipway/runner.sock"
    RUNNER_DATA_DIR    = "/var/lib/slipway-runner"
    RUNNER_BUILD_USER  = "slipway-build"
    RUNNER_MAX_BUILDS  = var.runner_max_builds
    RUNNER_MAX_DEPLOYS = var.runner_max_deploys
    # Empty: the runner uses the instance role directly, no assumed roles.
    RUNNER_PUBLISH_PROFILE = ""
    RUNNER_DEPLOY_PROFILE  = ""
    SLIPWAY_HOME           = "/opt/slipway/current"
  }

  deployer_user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    deployer_env_file     = join("\n", [for k, v in local.deployer_env : "${k}=${v}"])
    runner_env_file       = join("\n", [for k, v in local.runner_env : "${k}=${v}"])
    origin_secret         = random_password.origin.result
    caddy_port            = local.caddy_port
    swap_gb               = var.swap_gb
    node_version          = var.node_version
    node_sha256           = var.node_sha256
    pm2_version           = var.pm2_version
    caddy_version         = var.caddy_version
    caddy_sha512          = var.caddy_sha512
    pm2_logrotate_version = var.pm2_logrotate_version
    update_script_b64     = filebase64("${path.module}/files/update-deployer.sh")
    create_admin_b64      = filebase64("${path.module}/files/create-admin.sh")
    pm2_wrapper_b64       = filebase64("${path.module}/files/pm2.sh")
    caddy_svc_b64         = filebase64("${path.module}/files/caddy.service")
    nftables_b64          = filebase64("${path.module}/files/slipway.nft")
  })
}

# Sent by CloudFront on every request to the instance; Caddy rejects requests
# without it (docs/contracts.md, "Deployer host").
resource "random_password" "origin" {
  length  = 48
  special = false
}

# --- Network --------------------------------------------------------------------

resource "aws_security_group" "deployer" {
  name        = "slipway-deployer"
  description = "slipway deployer: Caddy on 8080 from CloudFront only"
  vpc_id      = data.aws_vpc.default.id

  # Counts as ~55 rules against the security group quota (the prefix list's size).
  ingress {
    description     = "CloudFront to Caddy"
    protocol        = "tcp"
    from_port       = local.caddy_port
    to_port         = local.caddy_port
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  }

  # GitHub, AWS APIs, npm, container registries, nodejs.org.
  egress {
    description = "Outbound"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# A separate interface carries the Elastic IP before the instance boots (so
# user data never sees its address change) and outlives instance replacements.
resource "aws_network_interface" "deployer" {
  subnet_id       = data.aws_subnet.deployer.id
  security_groups = [aws_security_group.deployer.id]
  description     = "slipway deployer"

  tags = {
    Name = "slipway-deployer"
  }
}

resource "aws_eip" "deployer" {
  domain            = "vpc"
  network_interface = aws_network_interface.deployer.id

  tags = {
    Name = "slipway-deployer"
  }
}

# --- Instance -----------------------------------------------------------------

resource "aws_instance" "deployer" {
  ami                  = data.aws_ssm_parameter.al2023_x86_64.value
  instance_type        = var.deployer_instance_type
  iam_instance_profile = aws_iam_instance_profile.deployer.name

  primary_network_interface {
    network_interface_id = aws_network_interface.deployer.id
  }

  # Gzipped: the script plus its embedded files would exceed EC2's 16 KB
  # user data limit as plain text. cloud-init unpacks it.
  user_data_base64            = base64gzip(local.deployer_user_data)
  user_data_replace_on_change = true # user data only runs on first boot

  # IMDSv2 only, with a hop limit of 1 so containers (Docker build steps)
  # can't get a token. slipway-build is cut off by an nftables rule instead.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_endpoint               = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.deployer_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = "slipway-deployer"
  }

  lifecycle {
    # A newer AMI shouldn't silently replace the deployer on the next apply.
    # dnf-automatic applies security updates in place; to move to a new AMI,
    # replace the instance deliberately (docs/foundation.md).
    ignore_changes = [ami]
  }

  # User data reads /slipway/deployer/version and the release on first boot.
  depends_on = [aws_eip.deployer, aws_iam_role_policy.deployer]
}

# --- CloudFront ---------------------------------------------------------------

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Every viewer header (cookies, query strings, GitHub's X-Hub-Signature-256)
# plus CloudFront's own, including CloudFront-Forwarded-Proto and
# CloudFront-Viewer-Address, which the deployer uses for Secure cookies and
# per-IP login rate limiting.
data "aws_cloudfront_origin_request_policy" "all_viewer_and_cloudfront" {
  name = "Managed-AllViewerAndCloudFrontHeaders-2022-06"
}

resource "aws_cloudfront_distribution" "deployer" {
  enabled         = true
  comment         = "slipway deployer"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id   = "deployer"
    domain_name = aws_eip.deployer.public_dns

    custom_origin_config {
      http_port                = local.caddy_port
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "X-Slipway-Origin"
      value = random_password.origin.result
    }
  }

  default_cache_behavior {
    target_origin_id         = "deployer"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_and_cloudfront.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
