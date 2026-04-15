#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT_DIR" ]] || {
  printf 'Error: release-helper.sh must run inside a git repository.\n' >&2
  exit 1
}
cd "$ROOT_DIR"

BASE_BRANCH="main"
REMOTE=""
DRY_RUN=0
DO_MERGE=0
DO_TAG=0
DO_PUSH_TAG=0
CHERRY_PICKS=()
NEXT_TAG=""
CURRENT_BRANCH=""
INCOMING_COMMITS=""
DEPLOY_COMMAND=""

usage() {
  cat <<'EOF'
Usage: scripts/release-helper.sh [options]

Safe default behavior only fetches the upstream remote.

Options:
  --help                 Show this help message
  --dry-run              Print commands without executing them
  --remote <name>        Override upstream remote detection
  --base <branch>        Set base branch to fetch/merge from (default: main)
  --merge                Merge remote base branch into current branch
  --cherry-pick <commits...>
                         Cherry-pick one or more commits onto current branch
  --tag                  Build, copy dist artifact, and create the next local tag
  --push-tag             Push the new tag after creating it (implies --tag)
EOF
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi

  "$@"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

detect_remote() {
  if [[ -n "$REMOTE" ]]; then
    return 0
  fi

  if git remote get-url upstream >/dev/null 2>&1; then
    REMOTE="upstream"
  elif git remote get-url fwindy >/dev/null 2>&1; then
    REMOTE="fwindy"
  else
    fail 'Could not detect upstream remote. Use --remote <name>.'
  fi
}

capture_repo_context() {
  CURRENT_BRANCH="$(git branch --show-current)"
  INCOMING_COMMITS="$(git log --oneline HEAD..${REMOTE}/${BASE_BRANCH} | head -n 10 || true)"
}

ensure_clean_for_git_ops() {
  local git_dir
  git_dir="$(git rev-parse --git-dir)"

  if [[ -f "$git_dir/MERGE_HEAD" || -f "$git_dir/CHERRY_PICK_HEAD" || -f "$git_dir/REVERT_HEAD" || -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
    fail 'Another git operation is already in progress.'
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail 'Working tree is dirty. Commit or stash changes first.'
  fi
}

compute_next_tag() {
  local date_prefix today last_tag suffix next_build

  today="$(date +%Y%m%d)"
  date_prefix="v${today}-build"
  last_tag="$(git tag --list "${date_prefix}*" --sort=-version:refname | head -n 1)"

  if [[ -z "$last_tag" ]]; then
    next_build=1
  else
    suffix="${last_tag##*-build}"
    if [[ "$suffix" =~ ^[0-9]+$ ]]; then
      next_build=$((suffix + 1))
    else
      next_build=1
    fi
  fi

  NEXT_TAG="${date_prefix}${next_build}"
}

compute_deploy_command() {
  DEPLOY_COMMAND="bash ./scripts/deploy-management.sh"

  if [[ -n "$NEXT_TAG" ]]; then
    DEPLOY_COMMAND+=" --url http://121.40.167.152:8317/management.html?version=${NEXT_TAG}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --remote)
      [[ $# -ge 2 ]] || fail '--remote requires a value.'
      REMOTE="$2"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || fail '--base requires a value.'
      BASE_BRANCH="$2"
      shift 2
      ;;
    --merge)
      DO_MERGE=1
      shift
      ;;
    --cherry-pick)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        CHERRY_PICKS+=("$1")
        shift
      done
      [[ ${#CHERRY_PICKS[@]} -gt 0 ]] || fail '--cherry-pick requires at least one commit.'
      ;;
    --tag)
      DO_TAG=1
      shift
      ;;
    --push-tag)
      DO_PUSH_TAG=1
      DO_TAG=1
      shift
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [[ "$DO_MERGE" -eq 1 && ${#CHERRY_PICKS[@]} -gt 0 ]]; then
  fail '--merge and --cherry-pick cannot be used together.'
fi

detect_remote
compute_next_tag
compute_deploy_command

printf 'Using remote: %s\n' "$REMOTE"
printf 'Using base branch: %s\n' "$BASE_BRANCH"
printf 'Next tag: %s\n' "$NEXT_TAG"
printf 'Next local deploy command: %s\n' "$DEPLOY_COMMAND"
run git fetch "$REMOTE" "$BASE_BRANCH" --tags
capture_repo_context
printf 'Current branch: %s\n' "${CURRENT_BRANCH:-detached}"
if [[ -n "$INCOMING_COMMITS" ]]; then
  printf 'Incoming upstream commits (top 10):\n%s\n' "$INCOMING_COMMITS"
else
  printf 'Incoming upstream commits: none\n'
fi

if [[ "$DRY_RUN" -eq 0 && ( "$DO_MERGE" -eq 1 || ${#CHERRY_PICKS[@]} -gt 0 || "$DO_TAG" -eq 1 ) ]]; then
  ensure_clean_for_git_ops
fi

if [[ "$DO_MERGE" -eq 1 ]]; then
  run git merge --ff-only "${REMOTE}/${BASE_BRANCH}"
fi

if [[ ${#CHERRY_PICKS[@]} -gt 0 ]]; then
  run git cherry-pick "${CHERRY_PICKS[@]}"
fi

if [[ "$DO_TAG" -eq 1 ]]; then
  run env VERSION="$NEXT_TAG" npm run build
  run cp dist/index.html dist/management.html
  run git tag "$NEXT_TAG"

  if [[ "$DO_PUSH_TAG" -eq 1 ]]; then
    run git push origin "$NEXT_TAG"
  fi
fi

printf '\nNext steps:\n'
printf '  - Review git status and confirm the branch contents.\n'
if [[ "$DO_MERGE" -eq 0 && ${#CHERRY_PICKS[@]} -eq 0 ]]; then
  printf '  - Merge or cherry-pick upstream changes only if you still want them.\n'
fi
if [[ "$DO_TAG" -eq 1 ]]; then
  printf '  - Smoke-test dist/index.html and dist/management.html for %s.\n' "$NEXT_TAG"
  if [[ "$DO_PUSH_TAG" -eq 0 ]]; then
    printf '  - Push the tag manually when ready: git push origin %s\n' "$NEXT_TAG"
  fi
  printf '  - Create a GitHub release manually and upload dist/management.html.\n'
else
  printf '  - Run with --tag when you are ready to build and create the next release tag.\n'
fi
printf '  - Deploy management.html when ready: %s\n' "$DEPLOY_COMMAND"
printf '  - Push branch commits manually if needed; this helper never pushes commits.\n'
