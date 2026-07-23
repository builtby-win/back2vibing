#!/bin/bash
# b2v-agent-event.sh — Thin wrapper: pipes raw stdin to b2v agent-event.
# If b2v CLI or daemon is unreachable, exits 0 silently so the agent
# falls back to its native terminal prompt.
set -euo pipefail
umask 077

if [ "${B2V_DISABLED:-0}" = "1" ] || [ "${B2V_DISABLED:-false}" = "true" ]; then
  exit 0
fi

CODEX_AGENT_ID="openai-codex"
CODEX_NOTIFICATION_EVENT="Notification"

PAYLOAD_ARG="${1:-}"
FIRST_ARG="$PAYLOAD_ARG"

if [ -n "$PAYLOAD_ARG" ] && [[ "$PAYLOAD_ARG" == \{* ]]; then
  AGENT_ID="$CODEX_AGENT_ID"
  shift
  set -- --event "$CODEX_NOTIFICATION_EVENT" "$@"
else
  AGENT_ID="$FIRST_ARG"
  if [ -z "$AGENT_ID" ]; then exit 0; fi  # Misconfigured hook — fail silently
  shift
  if [ -n "${1:-}" ] && [[ "${1:-}" == \{* ]]; then
    PAYLOAD_ARG="$1"
    shift
  fi
fi

# jcode observer hooks have no stdin; their canonical JSON payload is exported
# in JCODE_HOOK_PAYLOAD instead.
if [ "$AGENT_ID" = "jcode" ] && [ -n "${JCODE_HOOK_PAYLOAD:-}" ]; then
  PAYLOAD_ARG="$JCODE_HOOK_PAYLOAD"
fi
# Remaining args forwarded verbatim (--event, --server-url, etc.)

EVENT_HINT=""
args=("$@")
idx=0
while [ "$idx" -lt "${#args[@]}" ]; do
  if [ "${args[$idx]}" = "--event" ] && [ $((idx + 1)) -lt "${#args[@]}" ]; then
    EVENT_HINT="${args[$((idx + 1))]}"
    break
  fi
  idx=$((idx + 1))
done

case "$(uname -s 2>/dev/null || true)" in
  Darwin) B2V_CONFIG_DIR="$HOME/Library/Application Support/back2vibing" ;;
  *) B2V_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/back2vibing" ;;
esac
B2V_LOG_DIR="${B2V_LOG_DIR:-/tmp/back2vibing}"
case "$B2V_LOG_DIR" in
  /*) ;;
  *) B2V_LOG_DIR="/tmp/back2vibing" ;;
esac

b2v_hook_log() {
  local log_file="$B2V_LOG_DIR/back2vibing.log"
  mkdir -p "$B2V_LOG_DIR" 2>/dev/null || return 0
  chmod 700 "$B2V_LOG_DIR" 2>/dev/null || true
  touch "$log_file" 2>/dev/null || return 0
  chmod 600 "$log_file" 2>/dev/null || true
  printf '[%s][HOOK][b2v-agent-event.sh][PID:%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$1" >> "$log_file" 2>/dev/null || true
}

if [ "${B2V_DISABLED:-0}" = "1" ] || [ "${B2V_DISABLED:-false}" = "true" ]; then
  b2v_hook_log "B2V_DISABLED=${B2V_DISABLED}; skipping hook"
  exit 0
fi


json_escape() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//$'\n'/\\n}"
  str="${str//$'\t'/\\t}"
  str="${str//$'\r'/\\r}"
  printf '%s' "$str"
}

is_safe_ssh_tty_path() {
  case "$1" in
    /dev/tty*|/dev/pts/*) [ -c "$1" ] ;;
    *) return 1 ;;
  esac
}

resolve_fresh_ssh_tty() {
  local current_tty="${SSH_TTY:-}"
  if [ -n "$current_tty" ] && is_safe_ssh_tty_path "$current_tty"; then
    printf '%s' "$current_tty"
    return 0
  fi
  current_tty=$(tty 2>/dev/null || printf "")
  [ "$current_tty" = "not a tty" ] && current_tty=""
  if [ -n "$current_tty" ] && is_safe_ssh_tty_path "$current_tty"; then
    printf '%s' "$current_tty"
    return 0
  fi
  return 1
}

emit_wrapper_event_line() {
  local line="B2V_EVT $1"
  local session_tty
  session_tty=$(resolve_fresh_ssh_tty 2>/dev/null) || session_tty=""
  if [ -n "$session_tty" ] && is_safe_ssh_tty_path "$session_tty"; then
    printf '%s\n' "$line" >> "$session_tty" 2>/dev/null && return
  fi
  if [ -t 2 ] && [ -w /dev/tty ]; then
    printf '%s\n' "$line" >> /dev/tty 2>/dev/null && return
  fi
  printf '%s\n' "$line" >&2
}

json_get_from_file() {
  local file_path="$1"
  local key="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file_path" "$key" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    value = data.get(sys.argv[2])
    if isinstance(value, str):
        print(value)
except Exception:
    pass
PY
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");const[p,k]=process.argv.slice(1);try{const d=JSON.parse(fs.readFileSync(p,"utf8"));const v=d[k];if(typeof v==="string")process.stdout.write(v);}catch(_){}}' "$file_path" "$key"
  fi
}

extract_session_id_from_file() {
  local file_path="$1"
  local session=""
  case "$AGENT_ID" in
    openai-codex)
      session=$(json_get_from_file "$file_path" "thread-id")
      [ -z "$session" ] && session=$(json_get_from_file "$file_path" "thread_id")
      [ -z "$session" ] && session=$(json_get_from_file "$file_path" "threadId")
      ;;
  esac
  [ -z "$session" ] && session=$(json_get_from_file "$file_path" "session_id")
  [ -z "$session" ] && session=$(json_get_from_file "$file_path" "sessionId")
  [ -z "$session" ] && session=$(json_get_from_file "$file_path" "conversation_id")
  [ -z "$session" ] && session=$(json_get_from_file "$file_path" "conversationId")
  [ -z "$session" ] && session="${B2V_SESSION_HASH:-}"
  printf '%s' "$session"
}


resolve_b2v_cli() {
  if [ -n "${B2V_CLI_PATH:-}" ] && [ -x "${B2V_CLI_PATH}" ]; then
    printf '%s\n' "$B2V_CLI_PATH"
    return 0
  fi

  local cache_file="${TMPDIR:-/tmp}/b2v-cli-path.cache"
  if [ -f "$cache_file" ]; then
    cli_path="$(tr -d '\r\n' < "$cache_file")"
    if [ -n "$cli_path" ] && [ -x "$cli_path" ]; then
      printf '%s\n' "$cli_path"
      return 0
    fi
  fi

  if [ -f "$B2V_CONFIG_DIR/cli.path" ]; then
    cli_path="$(tr -d '\r\n' < "$B2V_CONFIG_DIR/cli.path")"
    if [ -n "$cli_path" ] && [ -x "$cli_path" ]; then
      printf '%s\n' "$cli_path" > "$cache_file" 2>/dev/null || true
      printf '%s\n' "$cli_path"
      return 0
    fi
  fi

  for candidate in \
    "$HOME/.local/bin/b2v" \
    "/usr/local/bin/b2v" \
    "/Applications/back2vibing.app/Contents/MacOS/b2v" \
    "$HOME/Applications/back2vibing.app/Contents/MacOS/b2v"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate" > "$cache_file" 2>/dev/null || true
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v b2v >/dev/null 2>&1; then
    local resolved_b2v
    resolved_b2v="$(command -v b2v)"
    printf '%s\n' "$resolved_b2v" > "$cache_file" 2>/dev/null || true
    printf '%s\n' "$resolved_b2v"
    return 0
  fi

  for candidate in "$PWD/target/debug/b2v"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate" > "$cache_file" 2>/dev/null || true
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}


B2V_CLI="$(resolve_b2v_cli || true)"

b2v_hook_log "start agent_id=$AGENT_ID event_hint=${EVENT_HINT:-<none>} pwd=$PWD b2v_cli=${B2V_CLI:-<missing>}"

if [ "${B2V_SSH_WRAPPER:-0}" = "1" ]; then
  mkdir -p "$B2V_LOG_DIR" 2>/dev/null || true
  chmod 700 "$B2V_LOG_DIR" 2>/dev/null || true
  STDIN_FILE=$(mktemp "$B2V_LOG_DIR/b2v-agent-event-stdin.XXXXXX")
  trap 'rm -f "$STDIN_FILE"' EXIT
  if [ "$AGENT_ID" = "jcode" ] && [ -n "$PAYLOAD_ARG" ]; then
    printf '%s' "$PAYLOAD_ARG" > "$STDIN_FILE"
  elif [ -t 0 ]; then
    printf '{}' > "$STDIN_FILE"
  else
    cat > "$STDIN_FILE" || printf '{}' > "$STDIN_FILE"
  fi

  RAW_EVENT=$(cat "$STDIN_FILE" 2>/dev/null || printf "{}")
  [ -n "$RAW_EVENT" ] || RAW_EVENT='{}'
  SESSION_HASH=$(extract_session_id_from_file "$STDIN_FILE")
  [ -n "$SESSION_HASH" ] || SESSION_HASH="wrapper-event-unknown"
  CWD=$(json_get_from_file "$STDIN_FILE" "cwd")
  [ -n "$CWD" ] || CWD=$(pwd)
  TTY=$(resolve_fresh_ssh_tty 2>/dev/null || true)

  PAYLOAD="{\"event\":\"agent_event\",\"session_hash\":\"$(json_escape "$SESSION_HASH")\",\"agent_id\":\"$(json_escape "$AGENT_ID")\",\"event_hint\":\"$(json_escape "$EVENT_HINT")\",\"raw_event\":\"$(json_escape "$RAW_EVENT")\",\"cwd\":\"$(json_escape "$CWD")\""
  [ -n "$TTY" ] && PAYLOAD="$PAYLOAD,\"tty\":\"$(json_escape "$TTY")\""

  if [ -n "${TMUX_PANE:-}" ]; then
    tmux_session=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null || echo "")
    tmux_window_index=$(tmux display-message -p -t "$TMUX_PANE" '#{window_index}' 2>/dev/null || echo "")
    tmux_pane_index=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_index}' 2>/dev/null || echo "")
    tmux_client_pid=$(tmux display-message -p -t "$TMUX_PANE" '#{client_pid}' 2>/dev/null || echo "")
    PAYLOAD="$PAYLOAD,\"tmux_pane_id\":\"$(json_escape "$TMUX_PANE")\""
    [ -n "$tmux_session" ] && PAYLOAD="$PAYLOAD,\"tmux_session_name\":\"$(json_escape "$tmux_session")\""
    [[ "$tmux_window_index" =~ ^[0-9]+$ ]] && PAYLOAD="$PAYLOAD,\"tmux_window_index\":$tmux_window_index"
    [[ "$tmux_pane_index" =~ ^[0-9]+$ ]] && PAYLOAD="$PAYLOAD,\"tmux_pane_index\":$tmux_pane_index"
    [[ "$tmux_client_pid" =~ ^[0-9]+$ ]] && PAYLOAD="$PAYLOAD,\"tmux_client_pid\":$tmux_client_pid"
  fi

  PAYLOAD="$PAYLOAD}"
  b2v_hook_log "ssh-wrapper payload session_hash=$SESSION_HASH cwd=$CWD payload=$(printf '%s' "$PAYLOAD" | tr '\n' ' ')"
  emit_wrapper_event_line "$PAYLOAD"
  [[ "$AGENT_ID" == "gemini"* || "$AGENT_ID" == "gemini-cli"* ]] && printf '{"decision":"allow"}\n'
  exit 0
fi

if [ -z "$B2V_CLI" ]; then
  b2v_hook_log "skip missing_b2v_cli"
  exit 0
fi

# Pipe stdin through. If CLI fails, exit 0 — no JSON on stdout means
# the agent uses its native prompt as fallback.
if [ -n "$PAYLOAD_ARG" ] && { [ -t 0 ] || [ "$AGENT_ID" = "jcode" ]; }; then
  b2v_hook_log "exec cli=$B2V_CLI args=agent-event --agent $AGENT_ID $* payload_source=argv payload_bytes=${#PAYLOAD_ARG} event_hint=$EVENT_HINT"
  printf '%s' "$PAYLOAD_ARG" | "$B2V_CLI" agent-event --agent "$AGENT_ID" "$@" 2>/dev/null || {
    b2v_hook_log "cli_failed exit=$? cli=$B2V_CLI"
    exit 0
  }
else
  b2v_hook_log "exec cli=$B2V_CLI args=agent-event --agent $AGENT_ID $* payload_source=stdin event_hint=$EVENT_HINT"
  "$B2V_CLI" agent-event --agent "$AGENT_ID" "$@" 2>/dev/null || {
    b2v_hook_log "cli_failed exit=$? cli=$B2V_CLI"
    exit 0
  }
fi

b2v_hook_log "cli_success cli=$B2V_CLI"
