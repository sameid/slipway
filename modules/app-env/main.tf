# One app environment (design 5.3): RDS Postgres, the API on ECS Express Mode,
# a one-off migrate task, and the frontend on S3 + CloudFront.
# State key apps/<app>/<env>.tfstate. Applied in two phases by jobs/deploy-env.sh.
#
# Everything shared is found by convention at plan time, never passed in: the
# region's default VPC and subnets, and the foundation's IAM boundary, Express
# infrastructure role and alerts topic by their fixed names (docs/contracts.md).

locals {
  name    = "app-${var.app}-${var.env}"
  is_prod = var.env == "prod"

  # Sizes from app.yaml (design 5.2). Express Mode runs X86_64 only: the
  # provider has no CPU architecture argument (docs/contracts.md). The presets use
  # db.t3, which every region offers (some, like ca-west-1, have no db.t4g).
  sizes = {
    small  = { cpu = 256, memory = 512, db_class = "db.t3.micro", db_storage = 20, min_tasks = 1, max_tasks = 2 }
    medium = { cpu = 512, memory = 1024, db_class = "db.t3.small", db_storage = 50, min_tasks = 1, max_tasks = 3 }
    large  = { cpu = 1024, memory = 2048, db_class = "db.t3.medium", db_storage = 100, min_tasks = 2, max_tasks = 4 }
  }
  preset = local.sizes[var.size]

  create_service = var.service_image != ""
  create_migrate = var.migrate_image != ""

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # The region is dedicated to slipway; everything runs in its default VPC.
  subnet_ids = sort(data.aws_subnets.default.ids)

  # Foundation resources, by name (foundation/).
  permissions_boundary_arn = "arn:aws:iam::${local.account_id}:policy/slipway-boundary"
  express_infra_role_arn   = "arn:aws:iam::${local.account_id}:role/slipway-ecs-express-infra"
  alerts_topic_arn         = "arn:aws:sns:${local.region}:${local.account_id}:slipway-alerts"

  ecr_repository_arn = "arn:aws:ecr:${local.region}:${local.account_id}:repository/app-${var.app}"
  app_secret_prefix  = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/apps/${var.app}/${var.env}"
  app_secret_arns    = { for k in var.secret_names : k => "${local.app_secret_prefix}/${k}" }

  # Shared by the service and the migrate task. Credentials come from the
  # RDS-managed secret at connect time, never from env vars (design 5.2).
  db_env = {
    DB_HOST       = aws_db_instance.db.address
    DB_PORT       = tostring(aws_db_instance.db.port)
    DB_NAME       = aws_db_instance.db.db_name
    DB_SECRET_ARN = aws_db_instance.db.master_user_secret[0].secret_arn
  }

  # Staging runs launcher.cjs in front of the app, which swaps the code in
  # place when a deploy points the swap bucket's current.json at a release
  # built on the same base (design 5.11). Prod runs the image's own command.
  has_swap_bucket = var.env == "staging"
  swap            = local.has_swap_bucket && var.swap_base != "" && length(var.app_command) > 0 && var.launcher != ""
  swap_env = local.swap ? {
    SLIPWAY_APP_COMMAND = jsonencode(var.app_command)
    SLIPWAY_HEALTH_PATH = var.health_check_path
    SLIPWAY_SWAP_BUCKET = aws_s3_bucket.swap[0].bucket
    SLIPWAY_SWAP_BASE   = var.swap_base
    SLIPWAY_PLATFORM    = var.platform
    SLIPWAY_REGION      = local.region
  } : {}

  service_env = { for k, v in merge(local.db_env, {
    PORT      = tostring(var.api_port)
    APP_ENV   = var.env
    RELEASE   = var.release
    DEPLOY_ID = var.deploy_id
  }, local.swap_env) : k => v if v != "" }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# Lookups: default VPC and subnets, the app's log group
# ---------------------------------------------------------------------------

data "aws_vpc" "main" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Created by the app's shared stack (modules/app-shared).
data "aws_cloudwatch_log_group" "app" {
  name = "/slipway/app-${var.app}"
}

# ---------------------------------------------------------------------------
# Network
# Tasks run in the default (public) subnets with a public IP, which gives an
# internet-facing Express ALB and needs no NAT. RDS shares those subnets but
# has no public IP and only accepts connections from this environment's tasks.
# ---------------------------------------------------------------------------

resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "API tasks: Express service and migrate task"
  vpc_id      = data.aws_vpc.main.id
}

# Express Mode manages its own load balancer security group. Allowing the
# container port from inside the VPC lets the ALB reach tasks whether or not
# Express also wires its LB group to this one; nothing outside the VPC can.
resource "aws_vpc_security_group_ingress_rule" "task_from_vpc" {
  security_group_id = aws_security_group.task.id
  description       = "Load balancer to container port"
  cidr_ipv4         = data.aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = var.api_port
  to_port           = var.api_port
}

# Public IP + IGW: ECR pulls, Secrets Manager, SSM, CloudWatch Logs, third-party APIs.
resource "aws_vpc_security_group_egress_rule" "task_all" {
  security_group_id = aws_security_group.task.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "db" {
  name = "${local.name}-db"
  # EC2 allows only a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* in group descriptions.
  description = "RDS Postgres: reachable only from this environment API tasks"
  vpc_id      = data.aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from API tasks"
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db"
  subnet_ids = local.subnet_ids
}

resource "aws_db_instance" "db" {
  identifier     = "${local.name}-db"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = local.preset.db_class

  allocated_storage     = local.preset.db_storage
  max_allocated_storage = local.preset.db_storage * 2
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = "app"
  username                    = "app_admin"
  manage_master_user_password = true # RDS owns the password in Secrets Manager and rotates it

  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false # no public IP; only the task security group gets in

  backup_retention_period    = local.is_prod ? 14 : 7
  backup_window              = "08:00-09:00"         # UTC: 2-3am Mountain
  maintenance_window         = "sun:09:30-sun:10:30" # minor version upgrades (design 8)
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  # Prod keeps its data unless teardown says otherwise: deploy-env applies
  # destroying = true first, which lifts protection and names the final
  # snapshot uniquely so an app recreated under the same name can't collide.
  deletion_protection = local.is_prod && !var.destroying
  skip_final_snapshot = !local.is_prod
  final_snapshot_identifier = !local.is_prod ? null : (
    var.destroying ? "${local.name}-final-${formatdate("YYYYMMDDhhmmss", plantimestamp())}" : "${local.name}-final"
  )

  # Prod size changes wait for the maintenance window; staging applies at once.
  apply_immediately = !local.is_prod || var.destroying
}

resource "aws_cloudwatch_metric_alarm" "db_free_storage" {
  alarm_name          = "${local.name}-db-free-storage"
  alarm_description   = "${local.name}: under 10% of the initial allocation free (storage autoscaling may already be growing it)"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = local.preset.db_storage * 0.1 * 1024 * 1024 * 1024
  treat_missing_data  = "missing"
  alarm_actions       = [local.alerts_topic_arn]
  ok_actions          = [local.alerts_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.db.identifier
  }
}

# ---------------------------------------------------------------------------
# IAM: both roles carry the platform permissions boundary (design 7).
# The Express infrastructure role is shared and owned by the foundation.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls the image, writes logs, and fetches secrets at task start.
resource "aws_iam_role" "execution" {
  name                 = "${local.name}-exec"
  assume_role_policy   = data.aws_iam_policy_document.assume_ecs_tasks.json
  permissions_boundary = local.permissions_boundary_arn
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [local.ecr_repository_arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${data.aws_cloudwatch_log_group.app.arn}:*"]
  }

  # Only this app and environment's parameters (design 5.8). They're encrypted
  # with the AWS-managed aws/ssm key, whose key policy lets SSM decrypt for any
  # principal in the account that may read the parameter: no kms statement.
  statement {
    sid       = "AppSecrets"
    actions   = ["ssm:GetParameters"]
    resources = ["${local.app_secret_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# What the app code itself can do: read its own DB secret, nothing else.
resource "aws_iam_role" "task" {
  name                 = "${local.name}-task"
  assume_role_policy   = data.aws_iam_policy_document.assume_ecs_tasks.json
  permissions_boundary = local.permissions_boundary_arn
}

resource "aws_iam_role_policy" "task_db_secret" {
  name = "db-secret"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_db_instance.db.master_user_secret[0].secret_arn
    }]
  })
}

# ---------------------------------------------------------------------------
# Cluster and the migrate task (design 5.9)
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
}

# One-off: same image and DB access as the service. Phase 1 points it at the
# new release while the service stays on the old one.
resource "aws_ecs_task_definition" "migrate" {
  count = local.create_migrate ? 1 : 0

  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(local.preset.cpu)
  memory                   = tostring(local.preset.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64" # must match the service
  }

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = var.migrate_image
    essential   = true
    command     = var.migrate_command
    environment = [for k, v in merge(local.db_env, { APP_ENV = var.env }) : { name = k, value = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = data.aws_cloudwatch_log_group.app.name
        awslogs-region        = local.region
        awslogs-stream-prefix = "${var.env}/migrate"
      }
    }
  }])

  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.task_db_secret]
}

# ---------------------------------------------------------------------------
# API: ECS Express Mode service
# ---------------------------------------------------------------------------

# ECS keeps deleted service names reserved for a while, so names get a suffix.
resource "random_id" "service_suffix" {
  byte_length = 2
}

resource "aws_ecs_express_gateway_service" "api" {
  count = local.create_service ? 1 : 0

  service_name            = "${local.name}-api-${random_id.service_suffix.hex}"
  cluster                 = aws_ecs_cluster.main.name
  execution_role_arn      = aws_iam_role.execution.arn
  infrastructure_role_arn = local.express_infra_role_arn
  task_role_arn           = aws_iam_role.task.arn
  cpu                     = tostring(local.preset.cpu)
  memory                  = tostring(local.preset.memory)
  health_check_path       = var.health_check_path
  wait_for_steady_state   = true

  primary_container {
    image          = var.service_image
    container_port = var.api_port
    # The image's ENTRYPOINT (node's docker-entrypoint.sh) runs this with node.
    command = local.swap ? ["node", "-e", var.launcher] : null

    aws_logs_configuration {
      log_group         = data.aws_cloudwatch_log_group.app.name
      log_stream_prefix = "${var.env}/api"
    }

    dynamic "environment" {
      for_each = local.service_env
      content {
        name  = environment.key
        value = environment.value
      }
    }

    # Declared in app.yaml; deploy-env has already checked each one exists.
    dynamic "secret" {
      for_each = local.app_secret_arns
      content {
        name       = secret.key
        value_from = secret.value
      }
    }
  }

  network_configuration {
    subnets         = local.subnet_ids
    security_groups = [aws_security_group.task.id]
  }

  # Set explicitly: left null, Express Mode fills in AVERAGE_CPU / 60 and
  # provider 6.68 fails the apply with "inconsistent result after apply".
  scaling_target {
    min_task_count            = local.preset.min_tasks
    max_task_count            = local.preset.max_tasks
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 60
  }

  # Keep the roles and capacity providers until the service has drained on destroy.
  depends_on = [
    aws_iam_role_policy.execution,
    aws_iam_role_policy.task_db_secret,
    aws_iam_role_policy.task_swap,
    aws_ecs_cluster_capacity_providers.main,
  ]
}

locals {
  # Endpoint looks like https://<service>.ecs.<region>.on.aws/; CloudFront wants the bare host.
  express_endpoint = local.create_service ? aws_ecs_express_gateway_service.api[0].ingress_paths[0].endpoint : ""
  express_host     = local.create_service ? regex("^(?:https?://)?([^/]+)", local.express_endpoint)[0] : ""

  has_domain = var.custom_domain != ""
}

# ---------------------------------------------------------------------------
# Frontend: private S3 bucket behind CloudFront (origin access control).
# New buckets block public access, enforce bucket-owner ownership and encrypt
# by default, so only the bucket and CloudFront's read policy are declared.
# ---------------------------------------------------------------------------

# Staging's code swaps: current.json, which names the release the launcher
# runs, and that release's bundle (bundles/<commit>.tgz, the image's /app). An
# app-* bucket, so the permissions boundary lets the task role read it.
resource "aws_s3_bucket" "swap" {
  count         = local.has_swap_bucket ? 1 : 0
  bucket        = "${local.name}-swap-${local.account_id}"
  force_destroy = true # copies of release bundles; deploy-env writes them
}

resource "aws_iam_role_policy" "task_swap" {
  count = local.has_swap_bucket ? 1 : 0
  name  = "swap-bucket"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.swap[0].arn}/*" },
      # So a missing current.json is a 404, not a 403.
      { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.swap[0].arn },
    ]
  })
}

resource "aws_s3_bucket" "web" {
  bucket        = "${local.name}-web-${local.account_id}"
  force_destroy = true # only build output and config.json; every deploy rewrites them
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# SPA fallback on the default (S3) behavior only. A distribution-level custom
# error response would also rewrite the API's 404s into index.html.
resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var last = request.uri.split('/').pop();
      if (last.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  JS
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards everything (including Authorization) except Host: Express Mode's
# shared ALB routes by host name, so it must see its own host, not CloudFront's.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Created in phase 2 of the first deploy, once the Express URL exists.
resource "aws_cloudfront_distribution" "web" {
  count = local.create_service ? 1 : 0

  enabled             = true
  comment             = local.name
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  # The custom domain, if any. The /api/* behaviour doesn't forward Host, so the
  # Express load balancer never sees it.
  aliases = local.has_domain ? [var.custom_domain] : []

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = local.express_host

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern           = "/config.json"
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_disabled.id
    compress               = true
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # CloudFront only accepts the alias with a certificate that covers it. The
  # default certificate requires the provider's default minimum (TLSv1).
  viewer_certificate {
    cloudfront_default_certificate = !local.has_domain
    acm_certificate_arn            = local.has_domain ? var.certificate_arn : null
    ssl_support_method             = local.has_domain ? "sni-only" : null
    minimum_protocol_version       = local.has_domain ? "TLSv1.2_2021" : null
  }
}

resource "aws_s3_bucket_policy" "web" {
  count = local.create_service ? 1 : 0

  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web[0].arn } }
    }]
  })
}
