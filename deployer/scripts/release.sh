#!/usr/bin/env bash
# Publish a release of the deployer instance's software (the deployer, the
# runner, jobs/ and modules/) and roll it out. `slipway setup` runs it with the
# plugin's version; run it by hand to release a checkout. Needs AWS credentials
# for the account (AWS_PROFILE) and slipway's region (AWS_REGION).
#
#   1. builds and packs the release (scripts/pack.sh)
#   2. uploads it to s3://<artifacts bucket>/deployer/<version>.tgz
#      (RELEASES_BUCKET, default slipway-artifacts-<account>)
#   3. creates or updates /slipway/deployer/version, which a replacement
#      instance also installs
#   4. runs /opt/slipway/bin/update-deployer.sh on the instance tagged
#      Name=slipway-deployer through SSM Run Command, and prints its output.
#      The runner finishes the builds and deploys it's running before it
#      restarts (up to about 15 minutes), so this can take a while.
#
# Usage: deployer/scripts/release.sh [version]
#   version defaults to <UTC timestamp>-<git short sha>; it must match [A-Za-z0-9._-]+.
#   YES=1 skips the confirmation prompt. SKIP_CHECKS=1 skips the tests (pack.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PAGER=""
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ -n "${AWS_REGION:-}" ]] || die "Set AWS_REGION to slipway's region"
export AWS_REGION

for cmd in aws node npm tar; do command -v "$cmd" >/dev/null || die "$cmd is not installed"; done

sha=$(git rev-parse --short HEAD 2>/dev/null || echo local)
version="${1:-$(date -u +%Y%m%d-%H%M%S)-$sha}"
[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || die "version must match [A-Za-z0-9._-]+"
if [[ -n "$(git status --porcelain -- . ../jobs ../modules 2>/dev/null)" ]]; then
  echo "Warning: deployer/, jobs/ or modules/ has uncommitted changes; they will be in this release."
fi

identity=$(aws sts get-caller-identity --query '[Account, Arn]' --output text) \
  || die "No AWS credentials. Set AWS_PROFILE to the slipway account's profile"
account=${identity%%[[:space:]]*}
bucket="${RELEASES_BUCKET:-slipway-artifacts-$account}"
echo "Account/identity: $identity"
echo "Region:           $AWS_REGION"
echo "Bucket:           $bucket"
echo "Release:          $version (deployer, runner, jobs, modules)"
if [[ "${YES:-}" != "1" ]]; then
  read -r -p "Publish and roll out this deployer release in this account? Type 'yes' to continue: " answer
  [[ "$answer" == "yes" ]] || die "Aborted"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
scripts/pack.sh "$work/$version.tgz"

aws s3api head-bucket --bucket "$bucket" 2>/dev/null || die "Bucket $bucket doesn't exist; apply the foundation first"

echo "==> Uploading s3://$bucket/deployer/$version.tgz"
aws s3 cp --only-show-errors "$work/$version.tgz" "s3://$bucket/deployer/$version.tgz"
aws ssm put-parameter --name /slipway/deployer/version --value "$version" --type String --overwrite >/dev/null

instance=$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=slipway-deployer Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[[ -n "$instance" && "$instance" != "None" ]] || die "No running instance tagged Name=slipway-deployer"
[[ "$instance" != *[[:space:]]* ]] || die "More than one running instance tagged Name=slipway-deployer: $instance"

echo "==> Running update-deployer.sh $version on $instance"
command_id=$(aws ssm send-command \
  --instance-ids "$instance" \
  --document-name AWS-RunShellScript \
  --comment "slipway deployer $version" \
  --parameters "commands=/opt/slipway/bin/update-deployer.sh $version" \
  --timeout-seconds 1800 \
  --query Command.CommandId --output text)

status=Pending
for _ in $(seq 1 360); do
  sleep 5
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$status" in Pending | InProgress | Delayed) continue ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[[ "$status" == "Success" ]] || die "update-deployer.sh finished with status $status"

echo "==> Deployer $version is live."
