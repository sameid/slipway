# One SNS topic for platform alerts: the deployer publishes failed prod deploys
# to it, and the app-env module's RDS free-storage alarms notify it (they find
# it by name). Confirm the subscription email after the first apply.
#
# No instance alarms: EC2 recovers t3 instances from host failures
# automatically (simplified automatic recovery is on by default).

resource "aws_sns_topic" "alerts" {
  name = "slipway-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Budget for spend in this region only (design 8). CloudFront and other global services
# aren't billed to a region, so they don't count towards it. Emails directly.
resource "aws_budgets_budget" "region" {
  name         = "slipway-${var.region}"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_amount)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Region"
    values = [var.region]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }
}
