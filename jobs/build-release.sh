#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# build-release (design 5.6, docs/contracts.md): one commit of an app, in one of
# three modes. The runner calls it once per phase, each time as a different user:
#
#   prepare  runner       unpack the source zip into $SLIPWAY_WORK/src, validate app.yaml,
#                         open the work dir to the build user
#   verify   build user   (no AWS credentials; runs the app's own code)
#                           check:   secret scan
#                           release: secret scan, npm ci, migrations check, frontend build
#                           verify:  npm ci, type check, lint, tests
#   image    runner       (release mode) docker build of api/Dockerfile
#   publish  runner       (release mode, AWS_PROFILE=slipway-publish) push the image,
#                         upload web.tgz, app.yaml and migrations.sha256 to releases/<app>/<sha>/
#
# A PR's check (MODE=check) only stops what must never reach main; the release
# build (MODE=release) builds what staging runs. Type check, lint and tests run
# when someone verifies a release on the dashboard (MODE=verify), which prod
# requires before it takes the release.
#
# Inputs (env): APP, COMMIT_SHA, MODE (release | check | verify), PR_NUMBER
#   (check only), SLIPWAY_WORK, SLIPWAY_IMAGE (local tag), SLIPWAY_SOURCE_ZIP
#   (prepare), RELEASES_BUCKET and AWS_ACCOUNT_ID (publish),
#   SLIPWAY_SHARE_WORK=1 when the verify phase runs as a separate build user.
#
# Sharing the work dir: only the runner and the build user can reach it (the
# runner's ACLs), so its "other" permission bits are the build user's. prepare
# makes the unpacked source a+rwX for it; verify leaves what it built a+rX for
# the runner. See deployer/src/runner/runner.ts.
# Exports (publish): IMAGE_DIGEST, IMAGE_URI, WEB_ARTIFACT.

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

PHASE="${1:-}"
require_env APP COMMIT_SHA MODE SLIPWAY_WORK
case "$MODE" in
  release | check | verify) ;;
  *) die "MODE must be release, check or verify, not '$MODE'" ;;
esac
[[ "$APP" =~ ^[a-z][a-z0-9-]{1,18}[a-z0-9]$ ]] || die "invalid APP '$APP'"
SRC="$SLIPWAY_WORK/src"
IMAGE="${SLIPWAY_IMAGE:-slipway-local/app-$APP:${COMMIT_SHA:0:12}}"

# app.yaml as a plain file inside the source, never a link to somewhere else.
app_yaml() {
  [[ -f "$SRC/app.yaml" && ! -L "$SRC/app.yaml" ]] || die "app.yaml is missing from the repo root (or is a symbolic link)"
  echo "$SRC/app.yaml"
}

case "$PHASE" in

  prepare)
    require_env SLIPWAY_SOURCE_ZIP
    reset_exports
    echo "app $APP, commit $COMMIT_SHA, mode $MODE${PR_NUMBER:+, PR #$PR_NUMBER}"
    step prepare
    require_tools unzip node
    rm -rf "$SRC" "$SLIPWAY_WORK/unpack"
    mkdir -p "$SLIPWAY_WORK/unpack"
    unzip -q "$SLIPWAY_SOURCE_ZIP" -d "$SLIPWAY_WORK/unpack" || die "could not unpack the source zip"
    # GitHub's zipball holds one top-level folder (<owner>-<repo>-<sha>/).
    dirs=()
    for dir in "$SLIPWAY_WORK/unpack"/*/; do
      [[ -d "$dir" ]] && dirs+=("${dir%/}")
    done
    ((${#dirs[@]} == 1)) || die "expected one top-level folder in the source zip, found ${#dirs[@]}"
    mv "${dirs[0]}" "$SRC"
    rm -rf "$SLIPWAY_WORK/unpack"
    check_links "$SRC" "the repo"

    step app-yaml
    appyaml validate "$(app_yaml)" --app "$APP"
    # The build user installs into the source next, and deletes it afterwards.
    [[ -z "${SLIPWAY_SHARE_WORK:-}" ]] || chmod -R a+rwX "$SRC"
    ;;

  verify)
    # Readable by the runner, which builds the image and publishes from here.
    umask 0022
    if [[ -n "${SLIPWAY_SHARE_WORK:-}" ]]; then
      # Also whatever a tool created with tighter permissions of its own.
      # shellcheck disable=SC2154 # rc is set inside the trap
      trap 'rc=$?; chmod -R a+rX "$SRC" 2>/dev/null || true; (exit "$rc"); _on_exit' EXIT
    fi
    cd "$SRC"

    # Before anything merges or is published. Verify mode reads code that
    # already passed it, so it skips the scan.
    if [[ "$MODE" != verify ]]; then
      step secret-scan
      find_gitleaks
      if ((${#GITLEAKS[@]})); then
        # Our config, no ignore files and no gitleaks:allow comments, so a repo
        # can't switch the scan off. gitleaks always reads .gitleaksignore from the
        # scanned folder, so those are deleted from this throwaway copy.
        if [[ -z "$DEV" ]]; then
          find . -name .gitleaksignore -type f -delete
        elif [[ -n "$(find . -name .gitleaksignore -not -path '*/node_modules/*' -print -quit)" ]]; then
          echo "warning: .gitleaksignore is honoured in dev mode but ignored on the platform"
        fi
        config="$JOBS_DIR/gitleaks.toml"
        [[ "${GITLEAKS[0]}" != docker ]] || config=/gitleaks.toml
        "${GITLEAKS[@]}" dir --config "$config" --ignore-gitleaks-allow \
          --redact --no-banner --no-color --verbose --exit-code 1 . ||
          die "gitleaks found what looks like a committed secret (redacted above). Remove it from the code, rotate it, declare its name in app.yaml and set the value with /secret set."
      else
        echo "warning: neither gitleaks nor Docker is available; secret scan skipped (dev mode only)"
      fi
    fi

    case "$MODE" in
      check)
        echo "check passed for $APP at $COMMIT_SHA"
        ;;

      verify)
        step npm-ci
        npm ci --no-audit --no-fund

        step typecheck
        npm run typecheck

        step lint
        npm run lint

        step test
        npm test
        echo "verified $APP at $COMMIT_SHA"
        ;;

      release)
        BUILD_COMMAND=$(appyaml get "$(app_yaml)" web.build_command)
        OUTPUT_DIR=$(appyaml get "$(app_yaml)" web.output_dir)

        step npm-ci
        npm ci --no-audit --no-fund

        # Cheap, and a migration that collides would fail the deploy's migrate step.
        step migrations-check
        npm run db:check -w api

        step web-build
        bash -c "$BUILD_COMMAND"
        [[ -f "$OUTPUT_DIR/index.html" ]] || die "$OUTPUT_DIR/index.html is missing after '$BUILD_COMMAND' (web.output_dir in app.yaml)"
        ;;
    esac
    ;;

  image)
    [[ "$MODE" == release ]] || die "image only runs in release mode"
    require_tools docker
    cd "$SRC"
    check_links "$SRC" "the repo"

    step docker-build
    build_flags=(--platform linux/amd64 -f api/Dockerfile -t "$IMAGE")
    # BuildKit would otherwise add a provenance attestation, turning the image into an index.
    if docker buildx version >/dev/null 2>&1; then build_flags+=(--provenance=false); fi
    docker build "${build_flags[@]}" .
    ;;

  publish)
    [[ "$MODE" == release ]] || die "publish only runs in release mode"
    require_env RELEASES_BUCKET AWS_ACCOUNT_ID
    require_tools aws docker
    cd "$SRC"

    step publish
    appyaml validate "$(app_yaml)" --app "$APP"
    OUTPUT_DIR=$(appyaml get "$(app_yaml)" web.output_dir)
    [[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || die "$OUTPUT_DIR (web.output_dir) is missing or is a symbolic link"
    check_links "$SRC" "the repo"
    [[ -z "$(find "$OUTPUT_DIR" -type l -print -quit)" ]] ||
      die "the frontend build in $OUTPUT_DIR contains symbolic links; only plain files can be published"

    REGISTRY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
    REPO="$REGISTRY/app-$APP"
    aws ecr describe-repositories --repository-names "app-$APP" >/dev/null 2>&1 ||
      die "ECR repository app-$APP doesn't exist; deploy the app's shared stack first"

    image_digest() {
      aws ecr describe-images --repository-name "app-$APP" --image-ids "imageTag=$COMMIT_SHA" \
        --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
    }

    # Tags are immutable: a rebuild of the same commit (catch-up, retry) reuses
    # the image that's already there instead of failing to push.
    DIGEST=$(image_digest)
    if [[ "$DIGEST" == sha256:* ]]; then
      echo "app-$APP:$COMMIT_SHA is already in ECR ($DIGEST); reusing it"
    else
      aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
      docker tag "$IMAGE" "$REPO:$COMMIT_SHA"
      docker push "$REPO:$COMMIT_SHA" || echo "push failed; checking whether a parallel build pushed the same tag"
      docker image rm "$REPO:$COMMIT_SHA" >/dev/null 2>&1 || true
      DIGEST=$(image_digest)
      [[ "$DIGEST" == sha256:* ]] || die "could not push $REPO:$COMMIT_SHA"
    fi

    PREFIX="s3://$RELEASES_BUCKET/releases/$APP/$COMMIT_SHA"
    WEB_TGZ="$SLIPWAY_WORK/web.tgz"
    tar -czf "$WEB_TGZ" -C "$OUTPUT_DIR" .
    aws s3 cp "$WEB_TGZ" "$PREFIX/web.tgz" --only-show-errors
    # deploy-env reads app.yaml from here: source zips aren't kept after a build.
    aws s3 cp "$(app_yaml)" "$PREFIX/app.yaml" --content-type text/yaml --only-show-errors
    # And what its migrate task would apply: deploy-env skips the task when this
    # matches what the environment's last deploy applied.
    MIGRATIONS=$(appyaml migrations-hash "$SRC" --app "$APP")
    printf '%s\n' "$MIGRATIONS" >"$SLIPWAY_WORK/migrations.sha256"
    aws s3 cp "$SLIPWAY_WORK/migrations.sha256" "$PREFIX/migrations.sha256" --content-type text/plain --only-show-errors

    export_var IMAGE_DIGEST "$DIGEST"
    export_var IMAGE_URI "$REPO@$DIGEST"
    export_var WEB_ARTIFACT "$PREFIX/web.tgz"
    echo "release $APP@${COMMIT_SHA:0:7} published"
    ;;

  *) die "usage: build-release.sh prepare|verify|image|publish" ;;
esac
