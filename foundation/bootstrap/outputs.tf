output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

# Paste into foundation/backend.hcl.
output "backend_hcl" {
  value = <<-EOT
    bucket = "${aws_s3_bucket.state.bucket}"
    region = "${var.region}"
  EOT
}
