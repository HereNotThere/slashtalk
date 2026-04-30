#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required (e.g. 0.1.0)}"
: "${DMG_PATH:?DMG_PATH is required (path to Slashtalk-mac-universal.dmg)}"

if [[ -z "${HOMEBREW_TAP_TOKEN:-}" ]]; then
  echo "HOMEBREW_TAP_TOKEN not set — skipping Homebrew tap update."
  exit 0
fi

TAP_OWNER="${TAP_OWNER:-HereNotThere}"
TAP_REPO_NAME="${TAP_REPO_NAME:-homebrew-tap}"
CASK_TEMPLATE="${CASK_TEMPLATE:-$(cd "$(dirname "$0")/.." && pwd)/packaging/homebrew/slashtalk.rb}"
CASK_PATH_IN_TAP="${CASK_PATH_IN_TAP:-Casks/slashtalk.rb}"
GIT_USER_NAME="${GIT_USER_NAME:-github-actions[bot]}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

if [[ ! -f "$CASK_TEMPLATE" ]]; then
  echo "Cask template not found: $CASK_TEMPLATE" >&2
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
echo "Updating tap ${TAP_OWNER}/${TAP_REPO_NAME}: version=${VERSION} sha256=${SHA256}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

TAP_REMOTE="${TAP_REMOTE:-https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${TAP_OWNER}/${TAP_REPO_NAME}.git}"
git clone --depth 1 "$TAP_REMOTE" "$WORKDIR/tap"
cd "$WORKDIR/tap"

mkdir -p "$(dirname "$CASK_PATH_IN_TAP")"

awk -v ver="$VERSION" -v sha="$SHA256" '
  /^[[:space:]]*version "/ { sub(/"[^"]*"/, "\"" ver "\"") }
  /^[[:space:]]*sha256 "/  { sub(/"[^"]*"/, "\"" sha "\"") }
  { print }
' "$CASK_TEMPLATE" > "$CASK_PATH_IN_TAP"

if [[ -z "$(git status --porcelain -- "$CASK_PATH_IN_TAP")" ]]; then
  echo "No changes to $CASK_PATH_IN_TAP — already up to date."
  exit 0
fi

git config user.name  "$GIT_USER_NAME"
git config user.email "$GIT_USER_EMAIL"
git add "$CASK_PATH_IN_TAP"
git commit -m "slashtalk ${VERSION}"
git push origin HEAD
