#!/usr/bin/env bash
# Create a worktree for one task: a new branch from the latest origin/main, then
# npm ci so tests, typecheck and lint can run. Apps aren't run locally (no ports, no
# local database): changes are previewed on staging after /ship.
#
# Usage: new-worktree.sh <branch> [--no-install]
#   --no-install   skip npm ci (just create the worktree)
#
# Works with macOS's bash 3.2.
set -euo pipefail

die() { printf 'new-worktree: %s\n' "$*" >&2; exit 1; }
warn() { printf 'new-worktree: %s\n' "$*" >&2; }

branch=""
install=1
for arg in "$@"; do
  case "$arg" in
    --no-install) install=0 ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [[ -z $branch ]] || die "only one branch name, please"; branch=$arg ;;
  esac
done
[[ -n $branch ]] || die "usage: new-worktree.sh <branch>   (for example feat/loan-reminders)"
[[ $branch != main ]] || die "pick a task branch name such as feat/<thing> or fix/<thing>, not main"
git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "'$branch' isn't a valid branch name"

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "run this inside the app's git repo"
main=$(dirname "$common")
[[ -f $main/app.yaml ]] || die "$main has no app.yaml; is this a slipway app?"
app=$(sed -nE 's/^name:[[:space:]]*["'\'']?([a-z0-9-]+).*/\1/p' "$main/app.yaml" | head -n 1)
[[ -n $app ]] || die "couldn't read the app name from $main/app.yaml"
dir="$(dirname "$main")/$app-worktrees/$branch"

# Already set up? Reuse it.
existing=$(git -C "$main" worktree list --porcelain | awk -v ref="refs/heads/$branch" '
  /^worktree / { path = substr($0, 10) }
  $0 == "branch " ref { print path }')
if [[ -n $existing ]]; then
  echo "Branch $branch already has a worktree: $existing"
  echo "cd $existing"
  exit 0
fi
[[ ! -e $dir ]] || die "$dir already exists but isn't a worktree for $branch; remove it or pick another name"

# Start from the latest main on GitHub, not whatever the main checkout has.
if git -C "$main" fetch --quiet origin main 2>/dev/null; then
  base=origin/main
else
  warn "couldn't fetch origin/main; starting from the local main branch"
  base=main
fi
mkdir -p "$(dirname "$dir")"
if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main" worktree add --quiet "$dir" "$branch"
  echo "Reusing the existing local branch $branch"
else
  git -C "$main" worktree add --quiet --no-track -b "$branch" "$dir" "$base"
fi

if [[ $install == 1 ]]; then
  echo "Installing dependencies"
  (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $dir"
fi

cat <<EOF

Worktree ready for $branch
  path: $dir
Work only in this folder: cd $dir
EOF
