#!/usr/bin/env bash
# Real-host contract check for one pin from scripts/opencode-host-pins.json.
#
#   tests/host-contract/run-host.sh <pin-id>
#
# 1. Installs the packed plugin plus that host's package, and nothing else,
#    into a clean directory.
# 2. Starts the host isolated (own HOME, XDG and config dirs, `env -i`) with
#    no model and no credentials, and asserts the plugin loaded and exposes
#    exactly the four copilot_* tools.
#    - V1: GET /experimental/tool/ids.
#    - V2: GET /api/plugin reports the plugin active, and an observer plugin
#      writes the host's own tool list to a file (V2 has no tool-list route).
# 3. Runs drive.mjs against the installed package for the host's entry point,
#    with the fixture `copilot` shim first on PATH, and asserts a delegated
#    task completes and copilot_output returns the envelope.
#
# Environment:
#   TARBALL                 packed plugin (default: npm pack from the repo root;
#                           `bun run build` must have run)
#   HOST_CONTRACT_WORKDIR   parent for scratch dirs (default: $RUNNER_TEMP or
#                           $TMPDIR). Kept afterwards when HOST_CONTRACT_KEEP=1.
#   HOST_CONTRACT_TIMEOUT   seconds to wait for the host to load (default 90)
set -euo pipefail

pin_id="${1:?usage: run-host.sh <pin-id>}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
timeout_s="${HOST_CONTRACT_TIMEOUT:-90}"

read -r host package version < <(node "$here/util.mjs" pin "$pin_id")

parent="${HOST_CONTRACT_WORKDIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
work="$(mktemp -d "${parent%/}/host-contract-$pin_id.XXXXXX")"
install="$work/install"
project="$work/project"
log="$work/host.log"
mkdir -p "$install" "$project" "$work/home" "$work/xdg/config" "$work/xdg/data" \
  "$work/xdg/cache" "$work/xdg/state" "$work/config" "$work/tmp"

server_pid=""
cleanup() {
  status=$?
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    # Only the process this script started. TERM first (a graceful stop that
    # runs V2 plugin cleanups); background jobs in a non-interactive shell
    # ignore SIGINT, so it can't be used here.
    for sig in TERM KILL; do
      kill "-$sig" "$server_pid" 2>/dev/null || break
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        kill -0 "$server_pid" 2>/dev/null || break 2
        sleep 0.5
      done
    done
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$log" ]; then
    echo "--- host log (last 60 lines): $log" >&2
    tail -n 60 "$log" >&2 || true
  fi
  if [ "${HOST_CONTRACT_KEEP:-0}" = "1" ]; then
    echo "scratch dir kept: $work" >&2
  else
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT

say() { echo "[$pin_id] $*"; }
die() { echo "[$pin_id] FAIL: $*" >&2; exit 1; }

# Nothing from the runner's profile reaches the host or the plugin.
node_dir="$(dirname "$(command -v node)")"
base_path="$node_dir:/usr/bin:/bin"
isolated_env=(
  "HOME=$work/home"
  "XDG_CONFIG_HOME=$work/xdg/config"
  "XDG_DATA_HOME=$work/xdg/data"
  "XDG_CACHE_HOME=$work/xdg/cache"
  "XDG_STATE_HOME=$work/xdg/state"
  "TMPDIR=$work/tmp"
  "OPENCODE_CONFIG_DIR=$work/config"
  "OPENCODE_DISABLE_AUTOUPDATE=true"
  "OPENCODE_DISABLE_LSP_DOWNLOAD=true"
  "OPENCODE_DISABLE_MODELS_FETCH=true"
  "OPENCODE_DISABLE_PRUNE=true"
)

# --- 1. Pack and clean install ---------------------------------------------
tarball="${TARBALL:-}"
if [ -z "$tarball" ]; then
  [ -f "$repo/dist/index.js" ] || die "dist/ missing; run 'bun run build' first"
  say "packing the plugin"
  packed="$(cd "$repo" && npm pack --silent --pack-destination "$work")"
  tarball="$work/$(echo "$packed" | tail -n 1)"
fi
[ -f "$tarball" ] || die "tarball not found: $tarball"
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"

say "installing $package@$version and $(basename "$tarball") into a clean dir"
printf '{"name":"host-contract-install","private":true,"type":"module"}\n' > "$install/package.json"
: > "$work/npmrc-user"
: > "$work/npmrc-global"
(
  cd "$install"
  NPM_CONFIG_USERCONFIG="$work/npmrc-user" NPM_CONFIG_GLOBALCONFIG="$work/npmrc-global" \
    npm install --no-audit --no-fund --no-progress --ignore-scripts \
    "$package@$version" "$tarball" > "$work/npm-install.log" 2>&1
) || { cat "$work/npm-install.log" >&2; die "npm install failed"; }

# Only this host's package may be present. A leaked host SDK would hide a
# runtime import of the other host's package (R3).
case "$host" in
  v1) other_pkgs=("@opencode/plugin" "@opencode/cli") ;;
  v2) other_pkgs=("@opencode-ai/plugin" "opencode-ai") ;;
  *) die "unknown host '$host' for pin" ;;
esac
for pkg in "${other_pkgs[@]}"; do
  [ ! -e "$install/node_modules/$pkg" ] || die "$pkg is installed; the clean dir must hold only the $host host"
done
[ -d "$install/node_modules/opencode-copilot-delegate/dist" ] || die "plugin not installed"

platform="$(node -p 'process.platform + "-" + process.arch')"
case "$host" in
  v1) bin="$install/node_modules/opencode-$platform/bin/opencode" ;;
  v2) bin="$install/node_modules/@opencode/cli-$platform/bin/opencode" ;;
esac
[ -x "$bin" ] || die "host binary not found at $bin (platform $platform)"
host_version="$(env -i PATH="$base_path" "${isolated_env[@]}" "$bin" --version 2>&1 | head -n 1)"
say "host binary: ${bin#"$install"/} reports '$host_version'"

entry_url="$(cd "$install" && node --input-type=module -e "console.log(import.meta.resolve('opencode-copilot-delegate'))")"
case "$entry_url" in
  file://*/node_modules/opencode-copilot-delegate/dist/index.js) ;;
  *) die "package entry resolved to an unexpected location: $entry_url" ;;
esac

port="$(node "$here/util.mjs" port)"
expect_tools() { node "$here/util.mjs" copilot-tools; }

start_host() {
  env -i PATH="$base_path" "${isolated_env[@]}" "$@" "$bin" serve --hostname 127.0.0.1 --port "$port" \
    > "$log" 2>&1 &
  server_pid=$!
}

poll() { # poll <description> <command...>: run until success or timeout
  local what="$1"
  shift
  local deadline=$((SECONDS + timeout_s))
  while ! "$@" > "$work/poll.out" 2>&1; do
    kill -0 "$server_pid" 2>/dev/null || die "host exited before $what"
    [ "$SECONDS" -lt "$deadline" ] || {
      echo "last probe output: $(head -c 600 "$work/poll.out")" >&2
      die "timed out after ${timeout_s}s waiting for $what"
    }
    sleep 1
  done
}

# --- 2. Start the host and assert the plugin loads -------------------------
case "$host" in
  v1)
    printf '{"$schema":"https://opencode.ai/config.json","plugin":["%s"]}\n' "$entry_url" > "$project/opencode.json"
    start_host
    v1_tool_ids() {
      curl -fsS -m 20 --get --data-urlencode "directory=$project" \
        "http://127.0.0.1:$port/experimental/tool/ids" | expect_tools
    }
    say "host started (pid $server_pid, port $port); waiting for the plugin to load"
    poll "exactly four copilot_* tool ids from /experimental/tool/ids" v1_tool_ids
    ;;
  v2)
    plugin_dir="$project/.opencode/plugin"
    mkdir -p "$plugin_dir/zz-observer"
    ln -s "$install/node_modules/opencode-copilot-delegate" "$plugin_dir/opencode-copilot-delegate"
    cp "$here/observer-plugin.js" "$plugin_dir/zz-observer/index.js"
    tools_file="$work/observed-tools.json"
    password="host-contract-$$-$RANDOM"
    start_host "OPENCODE_SERVER_PASSWORD=$password" "HOST_CONTRACT_TOOLS_FILE=$tools_file"
    v2_plugin_state() {
      curl -fsS -m 20 -u "opencode:$password" -H "x-opencode-directory: $project" \
        "http://127.0.0.1:$port/api/plugin" | node "$here/util.mjs" plugin-active
    }
    v2_observed_tools() { [ -f "$tools_file" ] && expect_tools < "$tools_file"; }
    say "host started (pid $server_pid, port $port); waiting for the plugin to activate"
    # /api/plugin is [] for a few seconds after a location is created.
    poll "/api/plugin to report opencode-copilot-delegate active" v2_plugin_state
    poll "the observer to list exactly four copilot_* tools" v2_observed_tools
    ;;
esac
say "plugin loaded: exactly four copilot_* tools registered by the real host"

# --- 3. Tool execution against the replay shim -----------------------------
cp "$here/drive.mjs" "$install/drive.mjs"
drive_path="$repo/tests/fixtures/bin:$base_path"
for mode in v1 v2; do
  say "drive $mode: delegate -> complete -> output (fixture copilot shim)"
  (cd "$install" && env -i PATH="$drive_path" "${isolated_env[@]}" node drive.mjs "$mode" "$project") \
    || die "drive.mjs $mode failed"
done

say "PASS $package@$version"
