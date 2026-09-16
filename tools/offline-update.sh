#!/usr/bin/env bash
#
# Update a remote deployment through an SSH connection, without that machine
# needing to reach GitHub itself.
#
# WHY THIS EXISTS
#
# mgmt2 cannot `git pull` from GitHub: HTTPS to github.com is blocked by SNI
# inspection, so the request hangs forever with no error. Changing the resolved
# IP does not help -- all of 140.82.112.3, 140.82.113.3 and 20.205.243.166 time
# out identically, which is what distinguishes an SNI block from a bad address.
# The TCP connection to github.com:443 succeeds; the TLS handshake is what dies.
#
# The preferred fix is to use the SSH transport (see the README): github.com:22
# and ssh.github.com:443 both complete a handshake from mgmt2. This script is for
# when that is not available either -- a fresh deployment with no key yet, or a
# network that blocks the SSH endpoints too.
#
# WHAT IT DOES
#
# Ships only the commits the target is missing, as a git bundle, over the SSH
# connection we already have. The target keeps a real git history: this is a
# fetch from a file, not a copy of files over the top of a checkout.
#
#   tools/offline-update.sh mgmt2
#   tools/offline-update.sh mgmt2 --build      # also install + build + report
#
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <ssh-host> [--build]" >&2
  exit 2
fi
shift || true

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

BRANCH="${BRANCH:-main}"
REMOTE_DIR="${REMOTE_DIR:-~/GPUStatus}"

say() { printf '  %s\n' "$*"; }

# The remote must already have this branch, because a bundle can only carry
# commits on top of something the other side has.
say "本地 $BRANCH: $(git rev-parse --short "$BRANCH")"
BASE="$(ssh "$HOST" "cd $REMOTE_DIR && git rev-parse --verify --quiet $BRANCH" || true)"
if [ -z "$BASE" ]; then
  echo "  $HOST:$REMOTE_DIR has no branch '$BRANCH' -- use 'git bundle create <file> --all' for a first transfer" >&2
  exit 1
fi
say "远端 $BRANCH: ${BASE:0:7}"

if [ "$BASE" = "$(git rev-parse "$BRANCH")" ]; then
  say "already up to date -- nothing to send"
  exit 0
fi

# A shallow or unrelated remote history makes `A..B` unresolvable locally, so
# fall back to shipping everything rather than failing with a git error the
# operator would have to decode.
BUNDLE="$(mktemp -t gpustatus-XXXXXX.bundle)"
trap 'rm -f "$BUNDLE"' EXIT

if git bundle create "$BUNDLE" "$BASE..$BRANCH" >/dev/null 2>&1; then
  say "incremental bundle: $(git rev-list --count "$BASE..$BRANCH") commit(s), $(du -h "$BUNDLE" | cut -f1)"
else
  say "incremental range unavailable; sending the full history"
  git bundle create "$BUNDLE" "$BRANCH" >/dev/null
  say "full bundle: $(du -h "$BUNDLE" | cut -f1)"
fi

REMOTE_BUNDLE="/tmp/gpustatus-$$.bundle"
scp -q "$BUNDLE" "$HOST:$REMOTE_BUNDLE"
say "transferred to $HOST:$REMOTE_BUNDLE"

# `git pull <file> <branch>` goes through the normal merge machinery, so a
# divergence is reported instead of being overwritten.
ssh "$HOST" "cd $REMOTE_DIR && git pull --ff-only '$REMOTE_BUNDLE' $BRANCH && rm -f '$REMOTE_BUNDLE'"
say "now at $(ssh "$HOST" "cd $REMOTE_DIR && git rev-parse --short $BRANCH")"

if [ "$BUILD" = 1 ]; then
  # --ignore-scripts: better-sqlite3 ships its native binary inside the npm
  # package, and npm's implicit `node-gyp rebuild` fails on a machine with no
  # compiler. Skipping it uses the bundled prebuild, which is the intended path.
  say "installing and building on $HOST"
  ssh "$HOST" "cd $REMOTE_DIR && npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm run build" | tail -3
  say "restart the service on $HOST: sudo systemctl restart gpustatus"
fi
