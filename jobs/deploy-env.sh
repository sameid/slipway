#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy-env (design 5.6): apply or destroy one of an app's stacks.
#
# Inputs (env): APP, ENV (shared | staging | prod), ACTION (apply | destroy),
#   and for staging/prod apply: COMMIT_SHA, IMAGE_DIGEST, WEB_ARTIFACT, DEPLOY_ID,
#   plus CUSTOM_DOMAIN and CERTIFICATE_ARN (both or neither) when the env has a
#   custom domain. Every apply passes them, so an apply without them detaches it.
#   SECRETS_REMOVED (KEY:KEY): secrets the dashboard is removing, left out of this deploy.
# From the runner: RELEASES_BUCKET, STATE_BUCKET, AWS_ACCOUNT_ID, SLIPWAY_HOME,
#   SLIPWAY_WORK, SLIPWAY_EXPORTS, and AWS_PROFILE=slipway-deploy for credentials.
#   It never runs app code: app.yaml is only parsed.
# Exports (staging/prod apply): APP_URL, SERVICE_URL.
#
# staging/prod apply:
#   secrets-check     every name under secrets: in app.yaml has a parameter for this env;
#                     every parameter the env has is injected, except SECRETS_REMOVED
#   deploy-mode       how: staging swaps the code into its running tasks (design 5.11) when
#                     only the code changed (same image base, inputs, secret values,
#                     domain and platform as the tasks started with); anything else,
#                     and every prod deploy, rolls out
#   swap              (a swap) copy the release's bundle to the swap bucket, point
#                     current.json at it, and wait until every task's launcher runs it
#   terraform-phase1  (a rollout) migrate task -> new image; the service stays exactly as it runs (image,
#                     release, deploy id and the last apply's secrets, size, port and
#                     health check), so this phase never rolls the old image out again
#   migrate           one-off Fargate task, skipped when the release's migrations (the
#                     hash build-release published) match the env's last deploy; stop
#                     here if it fails
#   rollout-settings  shorter canary waits and faster health checks on the service
#                     (best effort; skipped on the first deploy, before the service exists)
#   terraform-phase2  service -> new image and this release's inputs (first deploy: creates
#                     the service and CloudFront), then the rollout settings again
#   web-sync          frontend + config.json to S3, invalidate CloudFront
#   health-check      <app url><health_check> reports the new release; with a custom
#                     domain, also asks CloudFront for it directly (logs only)

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

require_env APP ENV ACTION STATE_BUCKET RELEASES_BUCKET AWS_ACCOUNT_ID SLIPWAY_WORK
[[ "$APP" =~ ^[a-z][a-z0-9-]{1,18}[a-z0-9]$ ]] || die "invalid APP '$APP'"
case "$ENV" in shared | staging | prod) ;; *) die "ENV must be shared, staging or prod, not '$ENV'" ;; esac
case "$ACTION" in apply | destroy) ;; *) die "ACTION must be apply or destroy, not '$ACTION'" ;; esac
reset_exports

# The generated root config, with module sources relative to $SLIPWAY_HOME/modules.
WORK_DIR="$SLIPWAY_WORK/tf"
TMP="$SLIPWAY_WORK/tmp"
mkdir -p "$WORK_DIR" "$TMP"
# Providers are shared between runs; terraform init isn't safe to run twice at
# once against one cache, so inits take a lock.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

tf() { terraform -chdir="$WORK_DIR" "$@"; }
# One output of the last apply. Before the first apply there's no state and
# terraform prints nothing; an output an older state doesn't have yet is "" too.
# Any other failure (terraform output reads the state from S3) is retried, then
# stops the deploy: carrying on with "" isn't safe. An empty service_image tells
# the module to remove the service, and an empty security group once started the
# migrate task where the database couldn't be reached.
tf_out() {
  local value attempt
  for attempt in 1 2 3; do
    if value=$(tf output -raw -no-color "$1" 2>"$TMP/tf-output.err"); then
      printf '%s' "$value"
      return 0
    fi
    grep -q "Output \"$1\" not found" "$TMP/tf-output.err" && return 0
    ((attempt == 3)) || sleep 5
  done
  die "terraform output $1 failed: $(grep -v '^[[:space:]]*$' "$TMP/tf-output.err" | head -n 3 | tr '\n' ' ')"
}
# An output the next command can't do without. Assign it to a variable first:
# set -e doesn't catch a failing $(...) that's only an argument to a command.
tf_req() {
  local value
  value=$(tf_out "$1") || exit 1
  [[ -n "$value" ]] || die "terraform output $1 is empty"
  printf '%s' "$value"
}
tf_init() {
  # Checksums of the pinned providers for every platform the runner runs on.
  # Terraform only takes a provider from the plugin cache when the lock file
  # lists it, so without this every init downloads the AWS provider again.
  cp "$JOBS_DIR/terraform.lock.hcl" "$WORK_DIR/.terraform.lock.hcl"
  if command -v flock >/dev/null; then
    flock "$TF_PLUGIN_CACHE_DIR/.init.lock" terraform -chdir="$WORK_DIR" init -input=false -no-color -reconfigure
  else
    tf init -input=false -no-color -reconfigure
  fi
}
tf_apply() { tf apply -input=false -auto-approve -no-color -lock-timeout=10m "$@"; }
tf_destroy() { tf destroy -input=false -auto-approve -no-color -lock-timeout=10m "$@"; }

render_env() { # extra args: --app-yaml FILE | --inputs-json FILE
  appyaml render-env --app "$APP" --env "$ENV" --out-dir "$WORK_DIR" --modules-dir "$SLIPWAY_HOME/modules" \
    --state-bucket "$STATE_BUCKET" --region "$AWS_REGION" "$@"
}

# Parameter names under /apps/<app>/<env>/, one per line.
secret_parameters() {
  aws ssm describe-parameters \
    --parameter-filters "Key=Path,Option=OneLevel,Values=/apps/$APP/$ENV" \
    --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed '/^$/d;/^None$/d'
}

delete_secret_parameters() {
  local names
  mapfile -t names < <(secret_parameters)
  while ((${#names[@]})); do
    aws ssm delete-parameters --names "${names[@]:0:10}" --query 'DeletedParameters' --output text
    names=("${names[@]:10}")
  done
}

# Express Mode rolls a new image out as a canary: 5% of traffic for a bake time,
# then all of it for another bake time before the old tasks stop (3 minutes
# each by default), and its target groups want 5 passing health checks 30
# seconds apart before a task gets traffic. That was 8 of a staging deploy's 12
# minutes. aws_ecs_express_gateway_service has no arguments for any of it, but
# Express Mode leaves these editable on the ECS service and its target groups
# (only the CANARY strategy itself is fixed), so they're set there. Staging
# skips the waits. Prod keeps a one-minute canary: shorter than the two bad
# minutes the rollback alarm needs, so a release that fails its health checks or
# keeps crashing is still stopped (the circuit breaker), but one that starts and
# then answers with errors mostly isn't. Each minute here is a minute of every
# prod deploy.
HEALTH_CHECK_INTERVAL=10
HEALTHY_THRESHOLD=2

# Express Mode's rollback alarm counts 4XX answers as errors once there are 5 in
# a minute, so on a quiet app one visitor getting 401s or 404s can roll back a
# good release. It is left as it is: a copy named on the service lasted only
# until the next update, when Express Mode put its own back on the list, and its
# own alarm rewritten to count 5XX only was restored at the start of every
# rollout. The short prod waits above are what narrow the window instead.

# Prints each setting as it was, and what it changed. Stops at the first failed
# call (set -e doesn't apply here: rollout_settings calls it from ||).
set_rollout_settings() { # cluster service
  local cluster=$1 service=$2 canary=1 final=0 config want was raw tg interval healthy copy
  [[ "$ENV" != staging ]] || { canary=0 final=0; }
  config=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].deploymentConfiguration' --output json) || return 1
  want=$config
  if [[ "$(jq -r .strategy <<<"$config")" != CANARY ]]; then
    echo "rollout waits: $service doesn't roll out as a canary; left alone"
  else
    want=$(jq -c --argjson canary "$canary" --argjson final "$final" \
      '.canaryConfiguration.canaryBakeTimeInMinutes = $canary | .bakeTimeInMinutes = $final' <<<"$want") || return 1
    was=$(jq -r '"canary \(.canaryConfiguration.canaryBakeTimeInMinutes)m, then \(.bakeTimeInMinutes)m"' <<<"$config") || return 1
    if [[ "$was" == "canary ${canary}m, then ${final}m" ]]; then
      echo "rollout waits: $was (already set)"
    else
      echo "rollout waits: $was -> canary ${canary}m, then ${final}m"
    fi
  fi

  # The copy of the alarm an earlier release named on the service instead (see
  # above): off the list, then deleted. Express Mode's own is the one it uses.
  copy="$cluster/$service/ServerErrorRollbackAlarm"
  want=$(jq -c --arg copy "$copy" --arg express "$cluster/$service/RollbackAlarm" \
    'if (.alarms.alarmNames // []) | index($copy) then .alarms.alarmNames = ((.alarms.alarmNames - [$copy]) + [$express] | unique) else . end' \
    <<<"$want") || return 1
  if [[ "$(jq -cS . <<<"$config")" != "$(jq -cS . <<<"$want")" ]]; then
    aws ecs update-service --cluster "$cluster" --service "$service" --deployment-configuration "$want" \
      --query 'service.serviceName' --output text >/dev/null || return 1
  fi
  if [[ "$(aws cloudwatch describe-alarms --alarm-names "$copy" --query 'length(MetricAlarms)' --output text)" != 0 ]]; then
    aws cloudwatch delete-alarms --alarm-names "$copy" || return 1
    echo "rollback alarm: deleted the earlier copy, $copy"
  fi

  # The service's revision names both of its target groups: each rollout moves
  # traffic from one to the other.
  raw=$(aws ecs list-service-deployments --cluster "$cluster" --service "$service" \
    --query 'serviceDeployments[0].targetServiceRevisionArn' --output text) || return 1
  [[ "$raw" == arn:* ]] || { echo "health checks: $service has no deployments yet"; return 1; }
  raw=$(aws ecs describe-service-revisions --service-revision-arns "$raw" \
    --query 'serviceRevisions[0].loadBalancers[].[targetGroupArn, advancedConfiguration.alternateTargetGroupArn]' \
    --output text) || return 1
  local tgs=()
  mapfile -t tgs < <(tr '\t' '\n' <<<"$raw" | sed '/^None$/d;/^$/d' | sort -u)
  ((${#tgs[@]})) || { echo "health checks: $service has no target groups"; return 1; }
  for tg in "${tgs[@]}"; do
    raw=$(aws elbv2 describe-target-groups --target-group-arns "$tg" \
      --query 'TargetGroups[0].[HealthCheckIntervalSeconds, HealthyThresholdCount]' --output text) || return 1
    read -r interval healthy <<<"$raw"
    if [[ "$interval $healthy" == "$HEALTH_CHECK_INTERVAL $HEALTHY_THRESHOLD" ]]; then
      echo "health checks (${tg#*:targetgroup/}): every ${interval}s, $healthy to pass (already set)"
    else
      aws elbv2 modify-target-group --target-group-arn "$tg" \
        --health-check-interval-seconds "$HEALTH_CHECK_INTERVAL" --healthy-threshold-count "$HEALTHY_THRESHOLD" \
        --query 'TargetGroups[0].TargetGroupName' --output text >/dev/null || return 1
      echo "health checks (${tg#*:targetgroup/}): every ${interval}s, $healthy to pass -> every ${HEALTH_CHECK_INTERVAL}s, $HEALTHY_THRESHOLD to pass"
    fi
  done
}

# Best effort: a deploy with Express Mode's defaults is only slower.
rollout_settings() { # cluster service
  set_rollout_settings "$@" ||
    echo "warning: couldn't set the rollout waits, rollback alarm and health checks ($(aws --version 2>&1 | cut -d' ' -f1)); this rollout uses Express Mode's defaults"
}

# What the service's primary deployment runs, as "image release deploy-id", or
# nothing. A failed rollout leaves the last apply's outputs naming what it tried
# to run while ECS rolled the service back; phase 1 passing those would roll the
# service out again before the migration.
running_service() { # cluster service
  local task_definition
  task_definition=$(aws ecs describe-services --cluster "$1" --services "$2" \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text) || return 1
  [[ "$task_definition" == arn:* ]] || return 1
  aws ecs describe-task-definition --task-definition "$task_definition" --output text \
    --query 'taskDefinition.containerDefinitions[?environment[?name==`DEPLOY_ID`]] | [0].[image, environment[?name==`RELEASE`].value | [0], environment[?name==`DEPLOY_ID`].value | [0]]'
}

# The app container's environment in what the service's primary deployment
# runs, as one JSON object (the launcher's settings are in it), and as
# SLIPWAY_LAUNCHER the launcher it runs, if any.
running_service_env() { # cluster service
  local task_definition
  task_definition=$(aws ecs describe-services --cluster "$1" --services "$2" \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text) || return 1
  [[ "$task_definition" == arn:* ]] || return 1
  aws ecs describe-task-definition --task-definition "$task_definition" --output json \
    --query 'taskDefinition.containerDefinitions[?environment[?name==`DEPLOY_ID`]] | [0].{environment: environment, command: command}' |
    jq -c '(.environment | map({(.name): .value}) | add // {}) + (if .command[0:2] == ["node", "-e"] then {SLIPWAY_LAUNCHER: .command[2]} else {} end)'
}

# The service's running tasks, as JSON: [{ip, startedAt}].
service_tasks() {
  local arns
  arns=$(aws ecs list-tasks --cluster "$CURRENT_CLUSTER" --service-name "$CURRENT_SERVICE" --desired-status RUNNING \
    --query taskArns --output text | tr '\t' ' ')
  if [[ -z "${arns// /}" || "$arns" == None ]]; then
    echo '[]'
    return
  fi
  # shellcheck disable=SC2086 # one argument per task ARN
  aws ecs describe-tasks --cluster "$CURRENT_CLUSTER" --tasks $arns --output json \
    --query 'tasks[?lastStatus==`RUNNING`].{ip: attachments[0].details[?name==`privateIPv4Address`].value | [0], startedAt: startedAt}'
}

# Whether a secret's value changed after the oldest running task started: ECS
# hands tasks their secrets when they start, so only new tasks would see it.
secrets_changed_since() { # tasks-json
  local changed
  changed=$(aws ssm describe-parameters --parameter-filters "Key=Path,Option=OneLevel,Values=/apps/$APP/$ENV" \
    --query 'Parameters[].LastModifiedDate' --output json) || return 0
  node -e '
    const t = (x) => (typeof x === "number" ? x * 1000 : Date.parse(x));
    const changed = JSON.parse(process.argv[1]).filter(Boolean).map(t);
    const started = JSON.parse(process.argv[2]).map((task) => t(task.startedAt));
    process.exit(changed.length && Math.max(...changed) > Math.min(...started) ? 0 : 1);
  ' "$changed" "$1"
}

# Why this deploy can't swap the code into staging's running tasks, or nothing
# when it can: only the code may differ from what the tasks were started with.
why_not_swap() {
  local tasks fields='{size, api_port, health_check_path, secret_names}'
  [[ -n "$NEW_BASE" ]] || { echo "release $SHORT has no swap bundle"; return; }
  [[ -n "$CURRENT_SERVICE" && -n "$SWAP_BUCKET" ]] || { echo "there's no service to swap into yet"; return; }
  [[ "$(jq -r '.SLIPWAY_SWAP_BASE // ""' <<<"$RUNNING_ENV")" == "$NEW_BASE" ]] ||
    { echo "the image changed (its Dockerfile, base image or command), or the service has no launcher yet"; return; }
  [[ "$(jq -r '.SLIPWAY_PLATFORM // ""' <<<"$RUNNING_ENV")" == "$PLATFORM" ]] || { echo "the platform changed"; return; }
  [[ -n "$RUNNING_INPUTS" && "$(jq -cS "$fields" <<<"$RUNNING_INPUTS")" == "$(jq -cS "$fields" <<<"$NEW_INPUTS")" ]] ||
    { echo "the secrets, size, port or health check changed"; return; }
  [[ "$(tf_out custom_domain)" == "$CUSTOM_DOMAIN" && "$(tf_out certificate_arn)" == "$CERTIFICATE_ARN" ]] ||
    { echo "the custom domain changed"; return; }
  tasks=$(service_tasks) || { echo "couldn't list the service's tasks"; return; }
  [[ "$(jq length <<<"$tasks")" != 0 ]] || { echo "the service has no running tasks"; return; }
  if secrets_changed_since "$tasks"; then echo "a secret's value changed since the tasks started"; fi
}

# current.json in the swap bucket: which release staging's launchers run. A
# rollout tells them to leave it to new tasks, which start from their image.
write_current() { # mode [bundle-key migrate]
  jq -n --arg mode "$1" --arg release "$SHORT" --arg commitSha "$COMMIT_SHA" --arg deployId "$DEPLOY_ID" \
    --arg base "$NEW_BASE" --arg bundle "${2:-}" --arg sha256 "$BUNDLE_SHA256" --argjson migrate "${3:-false}" \
    --argjson migrateCommand "$(jq -c '.migrate_command' <<<"$NEW_INPUTS")" --arg migrations "$NEW_MIGRATIONS" \
    '{mode: $mode, release: $release, commitSha: $commitSha, deployId: $deployId, base: $base, bundle: $bundle,
      sha256: $sha256, migrate: $migrate, migrateCommand: $migrateCommand, migrations: $migrations}' >"$TMP/current.json"
  aws s3 cp "$TMP/current.json" "s3://$SWAP_BUCKET/current.json" \
    --content-type application/json --cache-control no-store --only-show-errors
}

# Put back what current.json said before this deploy, so the launchers go back
# (or stay) there and a restarted task doesn't pick the failed release.
restore_current() {
  if [[ -n "$PREVIOUS_CURRENT" ]]; then
    printf '%s' "$PREVIOUS_CURRENT" | aws s3 cp - "s3://$SWAP_BUCKET/current.json" \
      --content-type application/json --cache-control no-store --only-show-errors || true
  else
    aws s3 rm "s3://$SWAP_BUCKET/current.json" --only-show-errors || true
  fi
}

# Every running task's launcher reports this deploy (the load balancer would
# only show one of them); a failure on any task stops the deploy.
wait_for_swap() {
  local deadline=$((SECONDS + ${SWAP_TIMEOUT_SECONDS:-300})) port ips ip status swapped failure progress last=""
  port=$(jq -r '.api_port' <<<"$NEW_INPUTS")
  while :; do
    mapfile -t ips < <(service_tasks | jq -r '.[].ip // empty')
    swapped=0
    failure=""
    for ip in "${ips[@]}"; do
      status=$(curl -fsS --max-time 3 "http://$ip:$port/__slipway/launcher" 2>/dev/null || true)
      if [[ "$(jq -r '.deployId // ""' <<<"$status" 2>/dev/null)" == "$DEPLOY_ID" ]]; then
        swapped=$((swapped + 1))
      elif [[ "$(jq -r '.failed.deployId // ""' <<<"$status" 2>/dev/null)" == "$DEPLOY_ID" ]]; then
        failure=$(jq -r '.failed.reason' <<<"$status")
      fi
    done
    progress="$swapped of ${#ips[@]} task(s) running $SHORT"
    [[ "$progress" == "$last" ]] || echo "$progress"
    last=$progress
    if [[ -n "$failure" ]]; then
      restore_current
      die "a task couldn't switch to $SHORT: $failure. Staging still runs ${RUNNING_RELEASE:-the previous release}; the app's output is in its logs"
    fi
    if ((${#ips[@]} > 0 && swapped == ${#ips[@]})); then return 0; fi
    if ((SECONDS > deadline)); then
      restore_current
      die "the tasks didn't switch to $SHORT within $((${SWAP_TIMEOUT_SECONDS:-300} / 60)) minutes; staging stays on ${RUNNING_RELEASE:-the previous release}"
    fi
    sleep 2
  done
}

# Keep the five newest bundles; a task that restarts needs only current.json's.
prune_bundles() {
  local keys=() i
  mapfile -t keys < <(aws s3api list-objects-v2 --bucket "$SWAP_BUCKET" --prefix bundles/ \
    --query 'sort_by(Contents || `[]`, &LastModified)[].Key' --output text | tr '\t' '\n' | sed '/^$/d;/^None$/d')
  for ((i = 0; i < ${#keys[@]} - 5; i++)); do
    aws s3 rm "s3://$SWAP_BUCKET/${keys[i]}" --only-show-errors || true
  done
}

step install
require_tools aws node curl
check_terraform
echo "app $APP, env $ENV, action $ACTION, release $(basename "$SLIPWAY_HOME"), AWS profile ${AWS_PROFILE:-default}"

# ---------------------------------------------------------------------------
# shared: ECR repository and log group
# ---------------------------------------------------------------------------

if [[ "$ENV" == shared ]]; then
  appyaml render-shared --app "$APP" --out-dir "$WORK_DIR" --modules-dir "$SLIPWAY_HOME/modules" \
    --state-bucket "$STATE_BUCKET" --region "$AWS_REGION"
  if [[ "$ACTION" == apply ]]; then
    step terraform-apply
    tf_init
    tf_apply
  else
    step terraform-destroy
    tf_init
    tf_destroy
    step release-cleanup
    # Best effort: the app is gone either way, and old artifacts only cost storage.
    aws s3 rm "s3://$RELEASES_BUCKET/releases/$APP/" --recursive --only-show-errors ||
      echo "warning: could not delete s3://$RELEASES_BUCKET/releases/$APP/; remove it by hand"
  fi
  echo "shared stack for $APP: $ACTION done"
  exit 0
fi

# ---------------------------------------------------------------------------
# staging / prod: destroy
# ---------------------------------------------------------------------------

if [[ "$ACTION" == destroy ]]; then
  step terraform-destroy
  # Re-render with the inputs the state was last applied with (the "inputs"
  # output), so lifting deletion protection doesn't also resize anything.
  printf '{"size":"small","api_port":3000,"health_check_path":"/api/health","migrate_command":["node","dist/migrate.js"],"secret_names":[]}' >"$TMP/inputs.json"
  render_env --inputs-json "$TMP/inputs.json"
  tf_init
  tf_out inputs >"$TMP/inputs.json"
  if [[ ! -s "$TMP/inputs.json" ]]; then
    echo "$APP has no $ENV environment in state; nothing to destroy"
  else
    render_env --inputs-json "$TMP/inputs.json"
    current=(
      -var "service_image=$(tf_out service_image)"
      -var "migrate_image=$(tf_out migrate_image)"
      -var "release=$(tf_out release)"
      -var "deploy_id=$(tf_out deploy_id)"
      -var "custom_domain=$(tf_out custom_domain)"
      -var "certificate_arn=$(tf_out certificate_arn)"
    )
    if [[ "$ENV" == prod ]]; then
      echo "Lifting deletion protection; RDS keeps a final snapshot"
      tf_apply "${current[@]}" -var destroying=true
    fi
    tf_destroy "${current[@]}" -var destroying=true
  fi
  step delete-alarms
  # Copies of the rollback alarm an earlier release made, if this environment
  # wasn't deployed again since (set_rollout_settings deletes them); Express
  # Mode deletes its own alarm with the service.
  mapfile -t alarms < <(aws cloudwatch describe-alarms --alarm-name-prefix "app-$APP-$ENV/" \
    --query "MetricAlarms[?ends_with(AlarmName, '/ServerErrorRollbackAlarm')].AlarmName" --output text |
    tr '\t' '\n' | sed '/^$/d;/^None$/d')
  if ((${#alarms[@]})); then
    aws cloudwatch delete-alarms --alarm-names "${alarms[@]}"
    printf 'deleted %s\n' "${alarms[@]}"
  fi
  step delete-secrets
  delete_secret_parameters
  echo "$APP $ENV destroyed"
  exit 0
fi

# ---------------------------------------------------------------------------
# staging / prod: apply (design 5.6)
# ---------------------------------------------------------------------------

require_env COMMIT_SHA IMAGE_DIGEST WEB_ARTIFACT DEPLOY_ID
[[ "$IMAGE_DIGEST" == sha256:* ]] || die "IMAGE_DIGEST must look like sha256:..., not '$IMAGE_DIGEST'"
SHORT="${COMMIT_SHA:0:7}"
NEW_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/app-$APP@$IMAGE_DIGEST"

CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"
if [[ -n "$CUSTOM_DOMAIN" || -n "$CERTIFICATE_ARN" ]]; then
  [[ "$CUSTOM_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && "$CUSTOM_DOMAIN" == *.* ]] ||
    die "CUSTOM_DOMAIN must be a lowercase hostname, not '$CUSTOM_DOMAIN'"
  [[ "$CERTIFICATE_ARN" =~ ^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$ ]] ||
    die "CERTIFICATE_ARN must be an ACM certificate in us-east-1, not '$CERTIFICATE_ARN'"
fi
domain_vars=(-var "custom_domain=$CUSTOM_DOMAIN" -var "certificate_arn=$CERTIFICATE_ARN")

# tf_apply, with a plain ERROR: line for the custom domain's own failures
# (Terraform's error box isn't one, so the deployer would only see "failed").
apply_env() {
  local status=0
  tf_apply "$@" 2>&1 | tee "$TMP/apply.log" || status=$?
  if ((status != 0)) && [[ -n "$CUSTOM_DOMAIN" ]]; then
    grep -q CNAMEAlreadyExists "$TMP/apply.log" &&
      die "$CUSTOM_DOMAIN is attached to another CloudFront distribution, maybe in another AWS account; it has to be removed there first"
    grep -q InvalidViewerCertificate "$TMP/apply.log" &&
      die "CloudFront won't use the certificate for $CUSTOM_DOMAIN ($CERTIFICATE_ARN); it may have been deleted or not cover the name"
  fi
  return "$status"
}

step app-yaml
aws s3 cp "s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA/app.yaml" "$TMP/app.yaml" --only-show-errors ||
  die "release $SHORT has no app.yaml in s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA/"
appyaml validate "$TMP/app.yaml" --app "$APP"
# What the release's migrate task applies (build-release); none from releases
# built before it was published, which always run the migrate task.
NEW_MIGRATIONS=$(aws s3 cp "s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA/migrations.sha256" - --only-show-errors 2>/dev/null | tr -d '[:space:]' || true)
[[ "$NEW_MIGRATIONS" =~ ^[0-9a-f]{64}$ ]] || NEW_MIGRATIONS=""
# For staging code swaps (design 5.11): the image's command and base, and the
# bundle's checksum (build-release), and this platform's module. A release
# built before image.json existed always rolls out.
aws s3 cp "s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA/image.json" "$TMP/image.json" --only-show-errors 2>/dev/null ||
  echo '{}' >"$TMP/image.json"
NEW_BASE=$(jq -r '.base // ""' "$TMP/image.json" 2>/dev/null || true)
NEW_APP_COMMAND=$(jq -c '.command // []' "$TMP/image.json" 2>/dev/null || echo '[]')
BUNDLE_SHA256=$(jq -r '.sha256 // ""' "$TMP/image.json" 2>/dev/null || true)
PLATFORM=$(appyaml tree-hash "$SLIPWAY_HOME/modules/app-env")
mapfile -t declared < <(appyaml get "$TMP/app.yaml" secrets | sed '/^$/d')
HEALTH_PATH=$(appyaml get "$TMP/app.yaml" api.health_check)

step secrets-check
mapfile -t existing < <(secret_parameters | sed "s#^/apps/$APP/$ENV/##")
existing_lines=$(printf '%s\n' "${existing[@]}")
if ((${#declared[@]})); then
  missing=()
  for key in "${declared[@]}"; do
    grep -qxF "$key" <<<"$existing_lines" || missing+=("$key")
  done
  if ((${#missing[@]})); then
    list=$(printf ', %s' "${missing[@]}")
    die "missing secrets for $ENV: ${list:2}. Set each one on the app's secrets page or with /secret set <NAME> --env $ENV, then deploy again"
  fi
  echo "all ${#declared[@]} secrets app.yaml requires are set for $ENV"
else
  echo "app.yaml requires no secrets"
fi
# Every parameter the env has goes into the task definition, not only app.yaml's
# (design 5.8), except the ones the dashboard is removing: SECRETS_REMOVED, KEY:KEY.
[[ "${SECRETS_REMOVED:-}" =~ ^[A-Z0-9_:]*$ ]] || die "SECRETS_REMOVED must be KEY:KEY, not '$SECRETS_REMOVED'"
# A command substitution, not < <(...), so a refusal stops the deploy.
inject_lines=$(appyaml secret-names "$TMP/app.yaml" --existing "$(IFS=:; echo "${existing[*]}")" --removed "${SECRETS_REMOVED:-}")
mapfile -t inject < <(sed '/^$/d' <<<"$inject_lines")
echo "injecting ${#inject[@]} secrets: $(IFS=,; echo "${inject[*]:-none}")"
[[ -z "${SECRETS_REMOVED:-}" ]] || echo "leaving out (being removed): ${SECRETS_REMOVED//:/, }"

step deploy-mode
render_phase2() { render_env --app-yaml "$TMP/app.yaml" --secret-names "$(IFS=:; echo "${inject[*]}")"; }
render_phase2
tf_init
# This release's module inputs, and the ones the service runs with (the last apply's).
NEW_INPUTS=$(jq -c '.module.env | {size, api_port, health_check_path, migrate_command, secret_names}' "$WORK_DIR/main.tf.json")
RUNNING_INPUTS=$(tf_out inputs)
LAST_MIGRATIONS=$(tf_out migrations)
CURRENT_IMAGE=$(tf_out service_image)
CURRENT_RELEASE=$(tf_out release)
CURRENT_DEPLOY_ID=$(tf_out deploy_id)
CURRENT_SERVICE=$(tf_out service_name)
CURRENT_CLUSTER=""
RUNNING_ENV='{}'
if [[ -n "$CURRENT_SERVICE" ]]; then
  CURRENT_CLUSTER=$(tf_req cluster_name)
  if read -r image release deploy_id < <(running_service "$CURRENT_CLUSTER" "$CURRENT_SERVICE") &&
    [[ "$image" == *@sha256:* && "$deploy_id" =~ ^[0-9]+$ && -n "$release" && "$release" != None ]]; then
    if [[ "$deploy_id" != "$CURRENT_DEPLOY_ID" ]]; then
      echo "the last deploy ($CURRENT_DEPLOY_ID) didn't finish: the service still runs deploy $deploy_id, which phase 1 keeps"
    fi
    CURRENT_IMAGE=$image CURRENT_RELEASE=$release CURRENT_DEPLOY_ID=$deploy_id
  else
    echo "warning: couldn't read what $CURRENT_SERVICE runs; phase 1 uses the last apply's outputs"
  fi
  RUNNING_ENV=$(running_service_env "$CURRENT_CLUSTER" "$CURRENT_SERVICE") || RUNNING_ENV='{}'
fi
# Code swaps leave the state alone: staging's current.json says which release
# the tasks run, and which migrations that applied.
SWAP_BUCKET=$(tf_out swap_bucket)
PREVIOUS_CURRENT=""
RUNNING_RELEASE=$CURRENT_RELEASE
if [[ -n "$SWAP_BUCKET" ]]; then
  PREVIOUS_CURRENT=$(aws s3 cp "s3://$SWAP_BUCKET/current.json" - --only-show-errors 2>/dev/null || true)
  if jq -e '.mode == "swap"' <<<"$PREVIOUS_CURRENT" >/dev/null 2>&1; then
    RUNNING_RELEASE=$(jq -r '.release' <<<"$PREVIOUS_CURRENT")
  fi
  swapped_migrations=$(jq -r '.migrations // empty' <<<"$PREVIOUS_CURRENT" 2>/dev/null || true)
  [[ -z "$swapped_migrations" ]] || LAST_MIGRATIONS=$swapped_migrations
fi
echo "service currently runs: ${RUNNING_RELEASE:-nothing (first deploy)}; deploying $SHORT"
SWAP_REASON="prod rolls out"
[[ "$ENV" != staging ]] || SWAP_REASON=$(why_not_swap)
if [[ -z "$SWAP_REASON" ]]; then
  echo "only the code changed: swapping it into the running tasks"
elif [[ "$ENV" == staging ]]; then
  echo "rolling out: $SWAP_REASON"
fi

# The migrate task (design 5.9): one-off, in the public subnets with a public
# IP and the env's task security group; its logs are printed, and a non-zero
# exit stops the deploy before the service changes.
run_migrate_task() {
  LOG_GROUP=$(tf_req log_group_name)
  MIGRATE_TASK_DEFINITION=$(tf_req migrate_task_definition_arn)
  SUBNET_IDS=$(tf_req subnet_ids)
  TASK_SECURITY_GROUP=$(tf_req task_security_group_id)
  read -r TASK_ARN FAILURE < <(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$MIGRATE_TASK_DEFINITION" \
    --launch-type FARGATE \
    --started-by "slipway-deploy-$DEPLOY_ID" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$TASK_SECURITY_GROUP],assignPublicIp=ENABLED}" \
    --query '[tasks[0].taskArn, failures[0].reason]' --output text)
  [[ "$TASK_ARN" == arn:* ]] || die "could not start the migrate task: $FAILURE"
  echo "migrate task: $TASK_ARN"

  deadline=$((SECONDS + ${MIGRATE_TIMEOUT_SECONDS:-1800}))
  while :; do
    read -r STATUS EXIT_CODE STOP_REASON < <(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
      --query 'tasks[0].[lastStatus, containers[0].exitCode, stoppedReason]' --output text)
    [[ "$STATUS" != STOPPED ]] || break
    if ((SECONDS > deadline)); then
      aws ecs stop-task --cluster "$CLUSTER" --task "$TASK_ARN" --reason "deploy-env timeout" >/dev/null || true
      die "the migration was still running after $((${MIGRATE_TIMEOUT_SECONDS:-1800} / 60)) minutes and was stopped; the service still runs ${CURRENT_RELEASE:-nothing}"
    fi
    sleep 10
  done

  echo "--- migrate logs ---"
  aws logs get-log-events --log-group-name "$LOG_GROUP" \
    --log-stream-name "$ENV/migrate/migrate/${TASK_ARN##*/}" --start-from-head \
    --query 'events[].message' --output text | tr '\t' '\n' || echo "(no logs)"
  echo "--- end of migrate logs ---"
  if [[ "$EXIT_CODE" != 0 ]]; then
    [[ "$STOP_REASON" == None ]] && STOP_REASON=""
    die "the migration failed (exit code $EXIT_CODE${STOP_REASON:+, $STOP_REASON}); the service still runs ${CURRENT_RELEASE:-nothing} and the deploy stopped here"
  fi
}

# Staging, when only the code changed (design 5.11): the launchers in the
# running tasks fetch the bundle, run its migrations if it brings new ones, and
# restart the app from it. No Terraform, migrate task or ECS rollout.
swap_in() {
  step swap
  local key="bundles/$COMMIT_SHA.tgz" migrate=true
  [[ -n "$NEW_MIGRATIONS" && "$NEW_MIGRATIONS" == "$LAST_MIGRATIONS" ]] && migrate=false
  # Where the task role can read it.
  aws s3 cp "s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA/app.tgz" "s3://$SWAP_BUCKET/$key" --only-show-errors
  write_current swap "$key" "$migrate"
  echo "current.json -> $SHORT (deploy $DEPLOY_ID$([[ "$migrate" == true ]] && echo ", with its migrations")); waiting for the tasks"
  wait_for_swap
  prune_bundles
  APP_URL=$(tf_req app_url)
  SERVICE_URL=$(tf_out service_url)
}

roll_out() {
  step terraform-phase1
  # The service keeps the inputs it runs with (the last apply's) through phase 1,
  # with only this release's migrate command for the migrate task. A secret added
  # or removed, or a new size, port or health check, then reaches the service
  # with the new image in phase 2, instead of first rolling the old image out
  # again with it (one more rollout, about 3.5 minutes).
  if [[ -n "$RUNNING_INPUTS" ]] &&
    jq -e 'has("size") and has("api_port") and has("health_check_path") and has("secret_names")' <<<"$RUNNING_INPUTS" >/dev/null 2>&1; then
    jq --argjson new "$NEW_INPUTS" '.migrate_command = $new.migrate_command' <<<"$RUNNING_INPUTS" >"$TMP/phase1-inputs.json"
    render_env --inputs-json "$TMP/phase1-inputs.json"
  fi
  # Likewise the launcher and its settings (staging), as the running tasks have them.
  jq -n --argjson env "$RUNNING_ENV" '{app_command: (($env.SLIPWAY_APP_COMMAND // "[]") | fromjson),
    swap_base: ($env.SLIPWAY_SWAP_BASE // ""), platform: ($env.SLIPWAY_PLATFORM // ""),
    launcher: ($env.SLIPWAY_LAUNCHER // "")}' >"$TMP/phase1.tfvars.json"
  apply_env \
    -var "service_image=$CURRENT_IMAGE" \
    -var "release=$CURRENT_RELEASE" \
    -var "deploy_id=$CURRENT_DEPLOY_ID" \
    -var "migrate_image=$NEW_IMAGE" \
    -var "migrations=$LAST_MIGRATIONS" \
    -var-file "$TMP/phase1.tfvars.json" \
    "${domain_vars[@]}"

  step migrate
  CLUSTER=$(tf_req cluster_name)
  if [[ -n "$NEW_MIGRATIONS" && "$NEW_MIGRATIONS" == "$LAST_MIGRATIONS" ]]; then
    # Same migrations folder and command as the env's last deploy: the task would
    # find nothing to apply, and starting it takes a minute or more.
    echo "no new migrations since $ENV's last deploy (${NEW_MIGRATIONS:0:12}); the migrate task isn't needed"
  else
    run_migrate_task
  fi

  SERVICE_NAME=$(tf_out service_name)
  if [[ -n "$SERVICE_NAME" ]]; then
    step rollout-settings
    rollout_settings "$CLUSTER" "$SERVICE_NAME"
  fi

  step terraform-phase2
  render_phase2
  # Staging: new tasks start this release from their image, and the old ones,
  # until they stop, leave a rollout alone. (Phase 1 made the bucket if it's new.)
  SWAP_BUCKET=$(tf_out swap_bucket)
  [[ -z "$SWAP_BUCKET" ]] || write_current rollout
  jq -n --argjson command "$NEW_APP_COMMAND" --arg base "$NEW_BASE" --arg platform "$PLATFORM" \
    --rawfile launcher "$SLIPWAY_HOME/modules/app-env/launcher.cjs" \
    '{app_command: $command, swap_base: $base, platform: $platform, launcher: $launcher}' >"$TMP/phase2.tfvars.json"
  apply_env \
    -var "service_image=$NEW_IMAGE" \
    -var "release=$SHORT" \
    -var "deploy_id=$DEPLOY_ID" \
    -var "migrate_image=$NEW_IMAGE" \
    -var "migrations=$NEW_MIGRATIONS" \
    -var-file "$TMP/phase2.tfvars.json" \
    "${domain_vars[@]}"
  APP_URL=$(tf_req app_url)
  SERVICE_URL=$(tf_out service_url)
  # Again after the rollout: a first deploy has just created the service, and
  # "already set" shows that Express Mode kept the settings through its update.
  echo "rollout settings after the rollout:"
  SERVICE_NAME=$(tf_req service_name)
  rollout_settings "$CLUSTER" "$SERVICE_NAME"
}

if [[ -z "$SWAP_REASON" ]]; then swap_in; else roll_out; fi

step web-sync
mkdir -p "$TMP/web"
aws s3 cp "$WEB_ARTIFACT" "$TMP/web.tgz" --only-show-errors || die "could not download $WEB_ARTIFACT"
tar -xzf "$TMP/web.tgz" -C "$TMP/web" --no-same-owner
[[ -f "$TMP/web/index.html" ]] || die "$WEB_ARTIFACT has no index.html"
# The bucket is public through CloudFront: upload plain files only, never what a link points at.
[[ -z "$(find "$TMP/web" -type l -print -quit)" ]] || die "$WEB_ARTIFACT contains symbolic links"
BUCKET=$(tf_req web_bucket)
# Hashed assets are cached for good and kept across deploys, so a page loaded
# before this deploy can still fetch its lazy chunks.
if [[ -d "$TMP/web/assets" ]]; then
  aws s3 sync "$TMP/web/assets" "s3://$BUCKET/assets" --no-follow-symlinks \
    --cache-control "public,max-age=31536000,immutable" --only-show-errors
fi
# Everything else is revalidated on every request. cp, not sync: sync compares
# sizes and times and would skip an older index.html on rollback.
aws s3 cp "$TMP/web" "s3://$BUCKET" --recursive --no-follow-symlinks --exclude "assets/*" --exclude config.json \
  --cache-control no-cache --only-show-errors
node -e 'process.stdout.write(JSON.stringify({ env: process.argv[1], release: process.argv[2] }) + "\n")' \
  "$ENV" "$SHORT" >"$TMP/config.json"
aws s3 cp "$TMP/config.json" "s3://$BUCKET/config.json" \
  --content-type application/json --cache-control no-store --only-show-errors
DISTRIBUTION_ID=$(tf_req distribution_id)
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text

step health-check
health_release() {
  node -e 'let b = ""; process.stdin.on("data", (d) => (b += d)).on("end", () => {
    try { process.stdout.write(String(JSON.parse(b).release ?? "")); } catch {}
  })'
}
body=""
for _ in $(seq 1 "${HEALTH_ATTEMPTS:-30}"); do
  if body=$(curl -fsS --max-time 10 "$APP_URL$HEALTH_PATH" 2>&1) && [[ "$(health_release <<<"$body")" == "$SHORT" ]]; then
    echo "$APP_URL$HEALTH_PATH: $body"
    if [[ -n "$CUSTOM_DOMAIN" ]]; then
      # Its DNS may not point here yet, so ask CloudFront directly: this shows
      # the alias and certificate work. Only logged; DNS is the owner's part.
      if domain_body=$(curl -fsS --max-time 10 --connect-to "$CUSTOM_DOMAIN:443:${APP_URL#https://}:443" \
        "https://$CUSTOM_DOMAIN$HEALTH_PATH" 2>&1); then
        echo "https://$CUSTOM_DOMAIN$HEALTH_PATH (asked CloudFront directly): ${domain_body:0:200}"
      else
        echo "warning: CloudFront didn't answer for https://$CUSTOM_DOMAIN yet: ${domain_body:0:200}"
      fi
    fi
    export_var APP_URL "$APP_URL"
    export_var SERVICE_URL "$SERVICE_URL"
    echo "$APP $ENV is live at $APP_URL (release $SHORT)"
    exit 0
  fi
  echo "waiting for $SHORT: ${body:0:200}"
  sleep 10
done
die "$APP_URL$HEALTH_PATH did not report release $SHORT within $((${HEALTH_ATTEMPTS:-30} * 10)) seconds; last response: ${body:0:200}"
