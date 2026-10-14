#!/usr/bin/env bash
# Remove worktrees whose pull requests are merged or closed, with their branches.
# Worktrees with uncommitted changes are skipped unless --force.
#
# Usage: clean-worktrees.sh [--dry-run] [--force] [--quiet]
#   --dry-run   list what would be removed, change nothing
#   --force     also remove worktrees with uncommitted changes
#   --quiet     print nothing when there's nothing to do
#
# Works with macOS's bash 3.2.
set -euo pipefail

die() { printf 'clean-worktrees: %s\n' "$*" >&2; exit 1; }
warn() { printf 'clean-worktrees: %s\n' "$*" >&2; }

dry_run=0 force=0 quiet=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --force) force=1 ;;
    --quiet) quiet=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "run this inside the app's git repo"
main=$(dirname "$common")
command -v gh >/dev/null || die "the GitHub CLI (gh) is needed to check PR states"

here=$(pwd -P)
found=0
removed=0
# Read the list on fd 3: gh reads stdin and would swallow it.
while IFS=$'\t' read -r wt branch <&3; do
  [[ -n $branch && $branch != main && $wt != "$main" ]] || continue
  state=$(cd "$main" && gh pr list --head "$branch" --state all --json state --jq '.[0].state // ""' 2>/dev/null) || state=""
  [[ $state == MERGED || $state == CLOSED ]] || continue
  found=$((found + 1))
  label=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')

  if [[ $dry_run == 1 ]]; then
    echo "$wt ($branch, PR $label)"
    continue
  fi
  case "$here/" in "$wt"/*)
    warn "skipping $wt: you're inside it; cd to $main first"
    continue ;;
  esac
  if [[ -d $wt && -n $(git -C "$wt" status --porcelain 2>/dev/null) && $force != 1 ]]; then
    warn "skipping $wt: it has uncommitted changes (use --force to remove anyway)"
    continue
  fi

  git -C "$main" worktree remove --force "$wt"
  git -C "$main" branch -D "$branch" >/dev/null 2>&1 || true
  echo "Removed $wt ($branch, PR $label)"
  removed=$((removed + 1))
done 3< <(git -C "$main" worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10); branch = "" }
  /^branch refs\/heads\// { branch = substr($0, 19) }
  /^$/ { if (path != "") print path "\t" branch; path = "" }
  END { if (path != "") print path "\t" branch }')

git -C "$main" worktree prune
app=$(sed -nE 's/^name:[[:space:]]*["'\'']?([a-z0-9-]+).*/\1/p' "$main/app.yaml" 2>/dev/null | head -n 1)
if [[ $dry_run == 0 && -n $app && -d "$(dirname "$main")/$app-worktrees" ]]; then
  find "$(dirname "$main")/$app-worktrees" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi

if [[ $found == 0 && $quiet == 0 ]]; then
  echo "No worktrees with merged or closed PRs."
elif [[ $dry_run == 0 && $quiet == 0 ]]; then
  echo "Removed $removed of $found finished worktree(s)."
fi
