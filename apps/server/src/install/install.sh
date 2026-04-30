#!/bin/sh
# slashtalk — CLI watcher install script
# Usage: curl <server>/install.sh | sh -s <setup_token>
set -eu

SERVER="${SLASHTALK_SERVER:-https://slashtalk.com}"
TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <setup_token>"
  echo "  Get a setup token from your slashtalk settings page."
  exit 1
fi

CONFIG_DIR="$HOME/.claude"
CONFIG_FILE="$CONFIG_DIR/slashtalk.json"
SYNC_FILE="$CONFIG_DIR/slashtalk-sync.json"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

github_full_name() {
  case "$1" in
    git@github.com:*)
      FULL_NAME=${1#git@github.com:}
      ;;
    ssh://git@github.com/*)
      FULL_NAME=${1#ssh://git@github.com/}
      ;;
    https://github.com/*)
      FULL_NAME=${1#https://github.com/}
      ;;
    http://github.com/*)
      FULL_NAME=${1#http://github.com/}
      ;;
    git://github.com/*)
      FULL_NAME=${1#git://github.com/}
      ;;
    *)
      return 1
      ;;
  esac

  FULL_NAME=${FULL_NAME%.git}
  case "$FULL_NAME" in
    */*) printf '%s\n' "$FULL_NAME" ;;
    *) return 1 ;;
  esac
}

# ── 1. Token exchange ────────────────────────────────────────

printf "Device name [$(hostname)]: "
read -r DEVICE_NAME
DEVICE_NAME="${DEVICE_NAME:-$(hostname)}"

echo "Exchanging setup token..."
EXCHANGE=$(curl -sf -X POST "$SERVER/v1/auth/exchange" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"deviceName\":\"$DEVICE_NAME\",\"os\":\"$OS\"}")

API_KEY=$(echo "$EXCHANGE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
DEVICE_ID=$(echo "$EXCHANGE" | grep -o '"deviceId":[0-9]*' | cut -d: -f2)

if [ -z "$API_KEY" ]; then
  echo "Error: token exchange failed."
  echo "$EXCHANGE"
  exit 1
fi

mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_FILE" << CONF
{
  "api_key": "$API_KEY",
  "device_id": $DEVICE_ID,
  "server": "$SERVER",
  "excluded_repos": [],
  "watched_repos": []
}
CONF
echo "Saved config to $CONFIG_FILE"

# ── 2. Repo discovery ────────────────────────────────────────

echo ""
echo "Scanning for git repos..."
REPO_DIRS=$(find "$HOME" -maxdepth 2 -name .git -type d 2>/dev/null || true)
REPO_META_FILE=$(mktemp)
trap 'rm -f "$REPO_META_FILE"' EXIT HUP INT TERM

if [ -z "$REPO_DIRS" ]; then
  printf "No repos found under ~. Enter a path to scan (or Enter to skip): "
  read -r EXTRA_PATH
  if [ -n "$EXTRA_PATH" ]; then
    REPO_DIRS=$(find "$EXTRA_PATH" -maxdepth 2 -name .git -type d 2>/dev/null || true)
  fi
fi

if [ -n "$REPO_DIRS" ]; then
  printf "Any additional directories to scan? (enter path or Enter to skip): "
  read -r EXTRA_PATH
  if [ -n "$EXTRA_PATH" ]; then
    EXTRA=$(find "$EXTRA_PATH" -maxdepth 2 -name .git -type d 2>/dev/null || true)
    REPO_DIRS="$REPO_DIRS
$EXTRA"
  fi
fi

# Build repo list
I=1
FOUND_REPOS=0
echo ""
echo "Discovered repos:"
while IFS= read -r GIT_DIR; do
  [ -z "$GIT_DIR" ] && continue
  REPO_DIR=$(dirname "$GIT_DIR")
  REMOTE=$(cd "$REPO_DIR" && git remote get-url origin 2>/dev/null || echo "")
  FULL_NAME=$(github_full_name "$REMOTE" 2>/dev/null || true)
  [ -z "$FULL_NAME" ] && continue
  printf '%s\t%s\n' "$REPO_DIR" "$FULL_NAME" >> "$REPO_META_FILE"
  echo "  [$I] [x] $FULL_NAME  ($REPO_DIR)"
  I=$((I + 1))
  FOUND_REPOS=$((FOUND_REPOS + 1))
done <<EOF
$REPO_DIRS
EOF

if [ "$FOUND_REPOS" -eq 0 ]; then
  echo "  (no GitHub repos found in scanned directories)"
fi

echo ""
echo "All repos selected by default. Enter numbers to deselect (comma-separated), or Enter to continue:"
read -r DESELECT

echo ""
echo "Syncing device repo selections..."
DESELECT=$(echo "$DESELECT" | tr -d ' ')
REPO_PATHS_JSON=""
EXCLUDED_JSON=""
I=1
while IFS='	' read -r REPO_DIR FULL_NAME; do
  [ -z "$REPO_DIR" ] && continue
  ESCAPED_PATH=$(json_escape "$REPO_DIR")
  ESCAPED_NAME=$(json_escape "$FULL_NAME")
  case ",$DESELECT," in
    *,"$I",*)
      [ -n "$EXCLUDED_JSON" ] && EXCLUDED_JSON="${EXCLUDED_JSON},"
      EXCLUDED_JSON="${EXCLUDED_JSON}\"$ESCAPED_NAME\""
      ;;
    *)
      [ -n "$REPO_PATHS_JSON" ] && REPO_PATHS_JSON="${REPO_PATHS_JSON},"
      REPO_PATHS_JSON="${REPO_PATHS_JSON}{\"fullName\":\"$ESCAPED_NAME\",\"localPath\":\"$ESCAPED_PATH\"}"
      ;;
  esac
  I=$((I + 1))
done < "$REPO_META_FILE"

REPOS_PAYLOAD="{\"repoPaths\":[${REPO_PATHS_JSON}],\"excludedRepos\":[${EXCLUDED_JSON}]}"
curl -sf -X POST "$SERVER/v1/devices/$DEVICE_ID/repos" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$REPOS_PAYLOAD" > /dev/null || echo "Warning: failed to sync device repo selections."

# ── 3. Initial upload ────────────────────────────────────────

echo ""
echo "Uploading existing session data..."
PROJECTS_DIR="$HOME/.claude/projects"
if [ -d "$PROJECTS_DIR" ]; then
  TOTAL=0
  for PROJECT_DIR in "$PROJECTS_DIR"/*/; do
    [ ! -d "$PROJECT_DIR" ] && continue
    PROJECT=$(basename "$PROJECT_DIR")
    for JSONL in "$PROJECT_DIR"*.jsonl; do
      [ ! -f "$JSONL" ] && continue
      SESSION=$(basename "$JSONL" .jsonl)
      SIZE=$(wc -c < "$JSONL" | tr -d ' ')
      echo "  Uploading $PROJECT/$SESSION ($SIZE bytes)..."
      curl -sf -X POST "$SERVER/v1/ingest?project=$PROJECT&session=$SESSION&fromOffset=0" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/x-ndjson" \
        --data-binary "@$JSONL" > /dev/null || echo "    (warning: upload failed)"
      TOTAL=$((TOTAL + 1))
    done
  done
  echo "Uploaded $TOTAL session files."
else
  echo "No session data found at $PROJECTS_DIR"
fi

# ── 4. Watch mode ─────────────────────────────────────────────

echo ""
echo "Starting watcher..."

# Initialize sync state
echo "{}" > "$SYNC_FILE"

watch_and_upload() {
  while true; do
    # Heartbeat: check live sessions
    if [ -d "$HOME/.claude/sessions" ]; then
      for SESS_FILE in "$HOME/.claude/sessions"/*.json; do
        [ ! -f "$SESS_FILE" ] && continue
        PID=$(grep -o '"pid":[0-9]*' "$SESS_FILE" 2>/dev/null | cut -d: -f2 || true)
        SESSION_ID=$(grep -o '"sessionId":"[^"]*"' "$SESS_FILE" 2>/dev/null | cut -d'"' -f4 || true)
        if [ -n "$PID" ] && [ -n "$SESSION_ID" ] && kill -0 "$PID" 2>/dev/null; then
          curl -sf -X POST "$SERVER/v1/heartbeat" \
            -H "Authorization: Bearer $API_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"sessionId\":\"$SESSION_ID\",\"pid\":$PID}" > /dev/null 2>&1 || true
        fi
      done
    fi

    # Check for new JSONL data
    if [ -d "$PROJECTS_DIR" ]; then
      for JSONL in "$PROJECTS_DIR"/*/*.jsonl; do
        [ ! -f "$JSONL" ] && continue
        PROJECT=$(basename "$(dirname "$JSONL")")
        SESSION=$(basename "$JSONL" .jsonl)
        CUR_SIZE=$(wc -c < "$JSONL" | tr -d ' ')

        # Simple offset tracking via file size
        OFFSET_FILE="$CONFIG_DIR/.offset_${SESSION}"
        PREV_SIZE=0
        [ -f "$OFFSET_FILE" ] && PREV_SIZE=$(cat "$OFFSET_FILE")

        if [ "$CUR_SIZE" -gt "$PREV_SIZE" ]; then
          tail -c +$((PREV_SIZE + 1)) "$JSONL" | \
            curl -sf -X POST "$SERVER/v1/ingest?project=$PROJECT&session=$SESSION&fromOffset=$PREV_SIZE" \
              -H "Authorization: Bearer $API_KEY" \
              -H "Content-Type: application/x-ndjson" \
              --data-binary @- > /dev/null 2>&1 || true
          echo "$CUR_SIZE" > "$OFFSET_FILE"
        fi
      done
    fi

    sleep 5
  done
}

# Offer to install as a service
echo "Would you like to install slashtalk as a background service? [Y/n] "
read -r INSTALL_SERVICE
INSTALL_SERVICE="${INSTALL_SERVICE:-Y}"

if [ "$INSTALL_SERVICE" = "Y" ] || [ "$INSTALL_SERVICE" = "y" ]; then
  if [ "$OS" = "darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.slashtalk.watcher.plist"
    SCRIPT="$CONFIG_DIR/slashtalk-watcher.sh"
    cat > "$SCRIPT" << 'WATCHER'
#!/bin/sh
CONFIG_DIR="$HOME/.claude"
CONFIG_FILE="$CONFIG_DIR/slashtalk.json"
API_KEY=$(grep -o '"api_key":"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)
SERVER=$(grep -o '"server":"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)
PROJECTS_DIR="$HOME/.claude/projects"

while true; do
  # Heartbeat
  if [ -d "$HOME/.claude/sessions" ]; then
    for f in "$HOME/.claude/sessions"/*.json; do
      [ ! -f "$f" ] && continue
      PID=$(grep -o '"pid":[0-9]*' "$f" 2>/dev/null | cut -d: -f2 || true)
      SID=$(grep -o '"sessionId":"[^"]*"' "$f" 2>/dev/null | cut -d'"' -f4 || true)
      if [ -n "$PID" ] && [ -n "$SID" ] && kill -0 "$PID" 2>/dev/null; then
        curl -sf -X POST "$SERVER/v1/heartbeat" \
          -H "Authorization: Bearer $API_KEY" \
          -H "Content-Type: application/json" \
          -d "{\"sessionId\":\"$SID\",\"pid\":$PID}" > /dev/null 2>&1 || true
      fi
    done
  fi
  # Upload new data
  if [ -d "$PROJECTS_DIR" ]; then
    for JSONL in "$PROJECTS_DIR"/*/*.jsonl; do
      [ ! -f "$JSONL" ] && continue
      P=$(basename "$(dirname "$JSONL")")
      S=$(basename "$JSONL" .jsonl)
      SZ=$(wc -c < "$JSONL" | tr -d ' ')
      OF="$CONFIG_DIR/.offset_${S}"
      PS=0; [ -f "$OF" ] && PS=$(cat "$OF")
      if [ "$SZ" -gt "$PS" ]; then
        tail -c +$((PS + 1)) "$JSONL" | \
          curl -sf -X POST "$SERVER/v1/ingest?project=$P&session=$S&fromOffset=$PS" \
            -H "Authorization: Bearer $API_KEY" \
            -H "Content-Type: application/x-ndjson" \
            --data-binary @- > /dev/null 2>&1 || true
        echo "$SZ" > "$OF"
      fi
    done
  fi
  sleep 5
done
WATCHER
    chmod +x "$SCRIPT"
    cat > "$PLIST" << LAUNCHD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.slashtalk.watcher</string>
  <key>ProgramArguments</key><array><string>$SCRIPT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$CONFIG_DIR/slashtalk-watcher.log</string>
  <key>StandardErrorPath</key><string>$CONFIG_DIR/slashtalk-watcher.log</string>
</dict>
</plist>
LAUNCHD
    launchctl load "$PLIST" 2>/dev/null || true
    echo "Installed launchd service. Watcher is running."
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT="$HOME/.config/systemd/user/slashtalk-watcher.service"
    mkdir -p "$(dirname "$UNIT")"
    SCRIPT="$CONFIG_DIR/slashtalk-watcher.sh"
    # Same script as above (written for darwin, works on linux too)
    cp "$CONFIG_DIR/slashtalk-watcher.sh" "$SCRIPT" 2>/dev/null || true
    cat > "$UNIT" << SYSTEMD
[Unit]
Description=slashtalk session watcher

[Service]
ExecStart=$SCRIPT
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SYSTEMD
    systemctl --user daemon-reload
    systemctl --user enable --now slashtalk-watcher.service
    echo "Installed systemd user service. Watcher is running."
  else
    echo "No service manager found. Running watcher in foreground..."
    watch_and_upload
  fi
else
  echo "Running watcher in foreground (Ctrl+C to stop)..."
  watch_and_upload
fi

echo ""
echo "slashtalk is set up! Your sessions will sync automatically."
