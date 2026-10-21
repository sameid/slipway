#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# deploy-env (design 5.6): apply or destroy one of an app's stacks.
#
# Inputs (env): APP, ENV (shared | staging | prod), ACTION (apply | destroy),
#   and for staging/prod apply: COMMIT_SHA, IMAGE_DIGEST, WEB_ARTIFACT, DEPLOY_ID,
#   plus CUSTOM_DOMAIN and CERTIFICATE_ARN (both or neither) when the env has a
#   custom domain. Every apply passes them, so an apply without them detaches it.
# From the runner: RELEASES_BUCKET, STATE_BUCKET, AWS_ACCOUNT_ID, SLIPWAY_HOME,
#   SLIPWAY_WORK, SLIPWAY_EXPORTS, and AWS_PROFILE=slipway-deploy for credentials.
#   It never runs app code: app.yaml is only parsed.
# Exports (staging/prod apply): APP_URL, SERVICE_URL.
#
# staging/prod apply:
#   secrets-check     every name under secrets: in app.yaml has a parameter for this env
#   terraform-phase1  migrate task -> new image; the service keeps its image, release and deploy id
#   migrate           one-off Fargate task; stop here if it fails
#   rollout-settings  shorter canary waits and faster health checks on the service
#                     (best effort; skipped on the first deploy, before the service exists)
#   terraform-phase2  service -> new image (first deploy: creates the service and CloudFront),
#                     then the rollout settings again
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
# a minute, so on a quiet app one visitor getting 401s (signed out) or 404s
# rolls back a good release. The service is pointed at a copy that counts 5XX
# only, with the same metrics, threshold and periods.
# Express Mode tags its own alarm AmazonECSManaged, so that one is left as it is
# and the copy belongs to the platform (deleted with the environment). Anything
# but the formula Express Mode used when this was written is left alone.
server_error_alarm_name() { echo "$1/$2/ServerErrorRollbackAlarm"; } # cluster service
SERVER_ERROR_ALARM=""
set_server_error_alarm() { # cluster service; sets SERVER_ERROR_ALARM
  local express="$1/$2/RollbackAlarm" ours want current
  ours=$(server_error_alarm_name "$1" "$2")
  SERVER_ERROR_ALARM=""
  want=$(aws cloudwatch describe-alarms --alarm-names "$express" --query 'MetricAlarms[0]' --output json) || return 1
  want=$(jq -c --arg name "$ours" '
    def rate: .Id | test("^em[0-9]+$");
    def express_formula: (.Id[1:]) as $m
      | "100 * (IF(\($m)_4xx < 5, 0, \($m)_4xx) + \($m)_5xx) / FILL(\($m)_total, 1)";
    if . == null or ([.Metrics[]? | select(rate)] | length) == 0
      or any(.Metrics[] | select(rate); .Expression != express_formula) then empty
    else {
      AlarmName: $name,
      AlarmDescription: "Rate of 5XX errors (slipway: 4XX answers, such as 401s and 404s, are not a failed release)",
      ActionsEnabled, EvaluationPeriods, DatapointsToAlarm, Threshold, ComparisonOperator, TreatMissingData,
      Metrics: [.Metrics[] | select(.Id | endswith("_4xx") | not)
        | if rate then (.Id[1:]) as $m
            | .Expression = "100 * \($m)_5xx / FILL(\($m)_total, 1)" | .Label = "5XX errors percentage, \(.Label | sub("^.* for "; ""))"
          else . end]
    } end' <<<"$want") || return 1
  if [[ -z "$want" ]]; then
    echo "rollback alarm: $express isn't in the shape this expects; the service keeps its alarms"
    return 0
  fi
  current=$(aws cloudwatch describe-alarms --alarm-names "$ours" --output json \
    --query 'MetricAlarms[0].{AlarmName: AlarmName, AlarmDescription: AlarmDescription, ActionsEnabled: ActionsEnabled, EvaluationPeriods: EvaluationPeriods, DatapointsToAlarm: DatapointsToAlarm, Threshold: Threshold, ComparisonOperator: ComparisonOperator, TreatMissingData: TreatMissingData, Metrics: Metrics}') ||
    return 1
  if [[ "$(jq -cS . <<<"$current")" != "$(jq -cS . <<<"$want")" ]]; then
    # Tags only apply when the alarm is created.
    aws cloudwatch put-metric-alarm --cli-input-json "$(jq -c --arg app "$APP" --arg env "$ENV" \
      '. + {Tags: [{Key: "app", Value: $app}, {Key: "env", Value: $env}, {Key: "platform", Value: "slipway"}]}' <<<"$want")" ||
      return 1
  fi
  SERVER_ERROR_ALARM=$ours
}

# Prints each setting as it was, and what it changed. Stops at the first failed
# call (set -e doesn't apply here: rollout_settings calls it from ||).
set_rollout_settings() { # cluster service
  local cluster=$1 service=$2 canary=1 final=0 config want was raw tg interval healthy
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

  set_server_error_alarm "$cluster" "$service" || return 1
  if [[ -n "$SERVER_ERROR_ALARM" ]]; then
    was=$(jq -r '.alarms.alarmNames // [] | join(", ")' <<<"$config") || return 1
    want=$(jq -c --arg alarm "$SERVER_ERROR_ALARM" '.alarms.alarmNames = [$alarm]' <<<"$want") || return 1
    if [[ "$was" == "$SERVER_ERROR_ALARM" ]]; then
      echo "rollback alarm: 5XX errors only (already set)"
    else
      echo "rollback alarm: ${was:-none} -> $SERVER_ERROR_ALARM (5XX errors only)"
    fi
  fi
  if [[ "$(jq -cS . <<<"$config")" != "$(jq -cS . <<<"$want")" ]]; then
    aws ecs update-service --cluster "$cluster" --service "$service" --deployment-configuration "$want" \
      --query 'service.serviceName' --output text >/dev/null || return 1
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
  # The rollback alarm copies the platform made (set_server_error_alarm);
  # Express Mode deletes its own with the service.
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
mapfile -t declared < <(appyaml get "$TMP/app.yaml" secrets | sed '/^$/d')
HEALTH_PATH=$(appyaml get "$TMP/app.yaml" api.health_check)

step secrets-check
if ((${#declared[@]})); then
  existing=$(secret_parameters)
  missing=()
  for key in "${declared[@]}"; do
    grep -qxF "/apps/$APP/$ENV/$key" <<<"$existing" || missing+=("$key")
  done
  if ((${#missing[@]})); then
    list=$(printf ', %s' "${missing[@]}")
    die "missing secrets for $ENV: ${list:2}. Set each one with /secret set <NAME> --env $ENV, then deploy again"
  fi
  echo "all ${#declared[@]} declared secrets are set for $ENV"
else
  echo "app.yaml declares no secrets"
fi

step terraform-phase1
render_env --app-yaml "$TMP/app.yaml"
tf_init
CURRENT_IMAGE=$(tf_out service_image)
CURRENT_RELEASE=$(tf_out release)
CURRENT_DEPLOY_ID=$(tf_out deploy_id)
CURRENT_SERVICE=$(tf_out service_name)
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
fi
echo "service currently runs: ${CURRENT_RELEASE:-nothing (first deploy)}; deploying $SHORT"
apply_env \
  -var "service_image=$CURRENT_IMAGE" \
  -var "release=$CURRENT_RELEASE" \
  -var "deploy_id=$CURRENT_DEPLOY_ID" \
  -var "migrate_image=$NEW_IMAGE" \
  "${domain_vars[@]}"

step migrate
CLUSTER=$(tf_req cluster_name)
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

SERVICE_NAME=$(tf_out service_name)
if [[ -n "$SERVICE_NAME" ]]; then
  step rollout-settings
  rollout_settings "$CLUSTER" "$SERVICE_NAME"
fi

step terraform-phase2
apply_env \
  -var "service_image=$NEW_IMAGE" \
  -var "release=$SHORT" \
  -var "deploy_id=$DEPLOY_ID" \
  -var "migrate_image=$NEW_IMAGE" \
  "${domain_vars[@]}"
APP_URL=$(tf_req app_url)
SERVICE_URL=$(tf_out service_url)
# Again after the rollout: a first deploy has just created the service, and
# "already set" shows that Express Mode kept the settings through its update.
echo "rollout settings after the rollout:"
SERVICE_NAME=$(tf_req service_name)
rollout_settings "$CLUSTER" "$SERVICE_NAME"

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
