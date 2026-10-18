# IAM: the deployer instance role (used by the deployer and the runner), the
# permissions boundary every app role carries, and the Express Mode
# infrastructure role every app service shares.
#
# var.region is dedicated to slipway, so the instance role may do anything
# there. What it can reach outside the region is scoped tightly, because the
# account may run other things elsewhere: IAM (only app-* roles, only with the
# boundary), CloudFront (only distributions tagged as slipway apps), ACM in
# us-east-1 (only certificates tagged as slipway's, for custom domains) and
# nothing else. Untrusted build steps run as a user that can't reach the
# instance metadata service, so they get none of this (docs/contracts.md).

# --- Permissions boundary for app roles ---------------------------------------

# The most an app role (task execution or task role) can ever do. A role's own
# policy narrows this to its app and environment; the boundary stops a change
# to the per-app module, or a compromised deployer, from granting more.
data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = ["arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/app-*"]
  }

  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/slipway/app-*",
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/slipway/app-*:*",
    ]
  }

  # Task roles: their RDS master secret (RDS names these rds!db-<uuid>).
  # Never slipway/github-app.
  statement {
    sid       = "DatabaseSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:rds!*"]
  }

  # App secrets use the AWS-managed aws/ssm key, which SSM decrypts for any
  # principal allowed to read the parameter: no kms statement needed.
  statement {
    sid       = "AppSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/apps/*"]
  }

  # Room for what apps commonly need, still limited to app-owned resources.
  statement {
    sid = "AppBuckets"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:${local.partition}:s3:::app-*",
      "arn:${local.partition}:s3:::app-*/*",
    ]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = "slipway-boundary"
  description = "Permissions boundary for every IAM role a slipway app deploy creates"
  policy      = data.aws_iam_policy_document.boundary.json
}

# --- Express Mode infrastructure role ------------------------------------------

data "aws_iam_policy_document" "express_infra_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "express_infra" {
  name               = "slipway-ecs-express-infra"
  description        = "Lets ECS Express Mode manage load balancers, certificates, security groups and scaling for slipway apps"
  assume_role_policy = data.aws_iam_policy_document.express_infra_trust.json
}

resource "aws_iam_role_policy_attachment" "express_infra" {
  role       = aws_iam_role.express_infra.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

# --- Deployer instance role ----------------------------------------------------

data "aws_iam_policy_document" "deployer_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "deployer" {
  name               = "slipway-deployer"
  description        = "slipway deployer host: the deployer, and the runner's builds and deploys"
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
}

# Session Manager, for maintenance without SSH.
resource "aws_iam_role_policy_attachment" "deployer_ssm" {
  role       = aws_iam_role.deployer.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

locals {
  app_role_arn = "arn:${local.partition}:iam::${local.account_id}:role/app-*"
}

data "aws_iam_policy_document" "deployer" {
  # Everything regional, in this region only: ECS, RDS, EC2, ELB, ECR, S3
  # buckets here, SSM, Secrets Manager, CloudWatch, SNS. IAM and STS are left
  # out even here (STS could otherwise assume other roles in the account).
  statement {
    sid         = "DedicatedRegion"
    not_actions = ["iam:*", "sts:*", "organizations:*", "account:*"]
    resources   = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  # --- IAM: only app-* roles, and only with the boundary ---

  statement {
    sid       = "IamRead"
    actions   = ["iam:Get*", "iam:List*"]
    resources = ["*"]
  }

  statement {
    sid = "CreateAppRolesWithBoundary"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy",
    ]
    resources = [local.app_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }

  statement {
    sid = "ManageAppRoles"
    actions = [
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ]
    resources = [local.app_role_arn]
  }

  statement {
    sid       = "PassAppRoles"
    actions   = ["iam:PassRole"]
    resources = [local.app_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com", "ecs.amazonaws.com"]
    }
  }

  statement {
    sid       = "PassExpressInfraRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.express_infra.arn]
  }

  # First use of RDS, ECS, Express Mode load balancers and autoscaling in the account.
  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "rds.amazonaws.com",
        "ecs.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "ecs.application-autoscaling.amazonaws.com",
      ]
    }
  }

  # Nobody on this box can lift the boundary or rewrite it.
  statement {
    sid    = "ProtectBoundary"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:DeleteRolePermissionsBoundary",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = ["*"]
  }

  # --- CloudFront (global): only distributions tagged as slipway apps ---

  statement {
    sid = "CloudFrontRead"
    actions = [
      "cloudfront:Describe*",
      "cloudfront:Get*",
      "cloudfront:List*",
    ]
    resources = ["*"]
  }

  # Creating a distribution can't touch existing ones. App distributions get
  # platform=slipway and app=<name> from the per-app default tags.
  statement {
    sid = "CreateAppDistributions"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:CreateDistributionWithTags",
    ]
    resources = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]
  }

  # Changing or deleting one needs both tags, so the account's other
  # distributions (and the deployer's own, which has no app tag) are out of reach.
  statement {
    sid = "ManageAppDistributions"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:DeleteDistribution",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:UpdateDistribution",
    ]
    resources = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/platform"
      values   = ["slipway"]
    }

    condition {
      test     = "Null"
      variable = "aws:ResourceTag/app"
      values   = ["false"]
    }
  }

  # CreateDistributionWithTags also needs TagResource on the new distribution,
  # which has no tags yet, so ManageAppDistributions can't match. Allow tagging
  # when the request sets platform=slipway. (That would also let this role
  # tag an existing distribution as slipway's and then manage it: the tag
  # scoping guards against accidents, not against a compromised instance.)
  statement {
    sid       = "TagNewAppDistributions"
    actions   = ["cloudfront:TagResource"]
    resources = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/platform"
      values   = ["slipway"]
    }
  }

  # Origin access controls are addressed by ID and can't be tagged. Creating
  # is harmless; deleting one that a distribution uses fails.
  statement {
    sid = "OriginAccessControls"
    actions = [
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
    ]
    resources = ["arn:${local.partition}:cloudfront::${local.account_id}:origin-access-control/*"]
  }

  statement {
    sid = "AppFunctions"
    actions = [
      "cloudfront:CreateFunction",
      "cloudfront:DeleteFunction",
      "cloudfront:PublishFunction",
      "cloudfront:UpdateFunction",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
    ]
    resources = ["arn:${local.partition}:cloudfront::${local.account_id}:function/app-*"]
  }

  # --- ACM in us-east-1: custom domains' certificates ---
  # CloudFront only uses certificates from us-east-1. The deployer requests them
  # DNS-validated and tagged as slipway's, and can only read or delete those.

  statement {
    sid       = "RequestAppCertificates"
    actions   = ["acm:RequestCertificate"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["us-east-1"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/platform"
      values   = ["slipway"]
    }
    condition {
      test     = "StringEquals"
      variable = "acm:ValidationMethod"
      values   = ["DNS"]
    }
  }

  # Tags given with the request are authorized as AddTagsToCertificate, which
  # doesn't carry acm:ValidationMethod, so it's its own statement.
  statement {
    sid       = "TagNewAppCertificates"
    actions   = ["acm:AddTagsToCertificate"]
    resources = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/platform"
      values   = ["slipway"]
    }
  }

  statement {
    sid       = "ManageAppCertificates"
    actions   = ["acm:DescribeCertificate", "acm:DeleteCertificate"]
    resources = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/platform"
      values   = ["slipway"]
    }
  }
}

resource "aws_iam_role_policy" "deployer" {
  name   = "deployer"
  role   = aws_iam_role.deployer.id
  policy = data.aws_iam_policy_document.deployer.json
}

resource "aws_iam_instance_profile" "deployer" {
  name = "slipway-deployer"
  role = aws_iam_role.deployer.name
}
