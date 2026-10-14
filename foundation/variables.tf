variable "region" {
  description = "Dedicated to slipway: the deployer's role may do anything in it, so nothing else should run there (ideally use an account just for slipway). Everything except CloudFront and IAM lives here."
  type        = string
}

variable "github_owner" {
  description = "GitHub org or personal account that owns every app repo. The deployer's GitHub App is installed on it."
  type        = string
}

variable "github_allowed_users" {
  description = "Personal-account owners only: other GitHub logins allowed to use the plugin API. In an org, membership decides instead. They also need write access to the app repos."
  type        = list(string)
  default     = []
}

variable "github_codeowners" {
  description = "CODEOWNERS entry for platform-owned files in new apps, e.g. \"@my-org/platform\". Empty: the owner on a personal account, the app's creator in an org."
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Receives deployer alerts (SNS: confirm the subscription email) and budget alerts."
  type        = string
}

variable "budget_amount" {
  description = "Monthly AWS Budgets limit in USD for spend in var.region. Emails at 80% actual and 100% forecast."
  type        = number
  default     = 500
}

variable "deployer_az_suffix" {
  description = "AZ of the default subnet the deployer runs in (a, b or c)."
  type        = string
  default     = "a"
}

variable "deployer_instance_type" {
  description = "Runs the deployer, the runner (npm installs, tests, Docker builds, Terraform) and Caddy. Must be x86_64: app images are linux/amd64 and are built here, and user data installs x86_64 binaries."
  type        = string
  default     = "t3.small"
}

variable "deployer_volume_gb" {
  description = "Root volume. Holds releases, the SQLite database, run logs, Docker images and build cache, npm caches and the swap file."
  type        = number
  default     = 40
}

variable "swap_gb" {
  description = "Swap file size. A t3.small has 2 GB of memory; builds and Terraform runs spill into swap rather than being killed."
  type        = number
  default     = 4
}

variable "runner_max_builds" {
  description = "build-release runs at a time (RUNNER_MAX_BUILDS). Builds are the memory-hungry part."
  type        = number
  default     = 1
}

variable "runner_max_deploys" {
  description = "deploy-env runs at a time (RUNNER_MAX_DEPLOYS). Deploys mostly wait on AWS."
  type        = number
  default     = 2
}

# Pinned downloads for the deployer host (x86_64). Update both halves of a
# pair together. Terraform and gitleaks aren't here: update-deployer.sh
# installs the versions pinned in each release's jobs/versions.env.
variable "node_version" {
  type    = string
  default = "24.21.0"
}

variable "node_sha256" {
  description = "SHA-256 of node-v<node_version>-linux-x64.tar.xz from https://nodejs.org/dist/v<version>/SHASUMS256.txt"
  type        = string
  default     = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
}

variable "pm2_version" {
  description = "pm2, installed globally with the pinned Node.js."
  type        = string
  default     = "7.0.4"
}

variable "caddy_version" {
  description = "2.11.6 and 2.11.7 (October 2026) changed proxy timeouts and had regressions; move up deliberately."
  type        = string
  default     = "2.11.4"
}

variable "caddy_sha512" {
  description = "SHA-512 of caddy_<version>_linux_amd64.tar.gz from caddy_<version>_checksums.txt on the GitHub release"
  type        = string
  default     = "8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9"
}

variable "pm2_logrotate_version" {
  description = "pm2-logrotate module, installed into root's pm2 to rotate app logs."
  type        = string
  default     = "3.0.0"
}
