#!/usr/bin/env bash
set -Eeuo pipefail

state_dir="${ARU_FAKE_RUNTIME_STATE_DIR:-${TMPDIR:-/tmp}/aru-fake-container-runtime}"
mkdir -p "$state_dir/containers" "$state_dir/volumes"

command="${1:-}"
shift || true

case "$command" in
  info|--version)
    echo "fake-container-runtime 1"
    exit 0
    ;;
  pull)
    [[ "${1:-}" != *failpull* ]] || exit 1
    exit 0
    ;;
  inspect)
    container_name="${@: -1}"
    [[ -f "$state_dir/containers/$container_name" ]] || exit 1
    echo "running"
    exit 0
    ;;
  stop|rm)
    container_name="${@: -1}"
    rm -f "$state_dir/containers/$container_name"
    exit 0
    ;;
  volume)
    volume_action="${1:-}"
    volume_name="${@: -1}"
    case "$volume_action" in
      inspect)
        [[ -f "$state_dir/volumes/$volume_name" ]]
        ;;
      create)
        touch "$state_dir/volumes/$volume_name"
        echo "$volume_name"
        ;;
      rm)
        rm -f "$state_dir/volumes/$volume_name"
        ;;
      *) exit 2 ;;
    esac
    exit 0
    ;;
  run)
    ;;
  *)
    exit 2
    ;;
esac

detached=false
container_name=""
workspace=""
source_plugin_runner=""
source_plugin_entry=""
source_plugin_data=""
network_disabled=false
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  argument="${arguments[$index]}"
  case "$argument" in
    -d)
      detached=true
      ;;
    --name)
      container_name="${arguments[$((index + 1))]}"
      ;;
    --network)
      [[ "${arguments[$((index + 1))]}" != "none" ]] || network_disabled=true
      ;;
    type=bind,src=*,dst=/workspace)
      workspace="${argument#type=bind,src=}"
      workspace="${workspace%,dst=/workspace}"
      ;;
    type=bind,src=*,dst=/aru/runner.mjs,ro)
      source_plugin_runner="${argument#type=bind,src=}"
      source_plugin_runner="${source_plugin_runner%,dst=/aru/runner.mjs,ro}"
      ;;
    type=bind,src=*,dst=/aru/plugin.mjs,ro)
      source_plugin_entry="${argument#type=bind,src=}"
      source_plugin_entry="${source_plugin_entry%,dst=/aru/plugin.mjs,ro}"
      ;;
    type=bind,src=*,dst=/data)
      source_plugin_data="${argument#type=bind,src=}"
      source_plugin_data="${source_plugin_data%,dst=/data}"
      ;;
  esac
done

if [[ "$detached" == "true" ]]; then
  last_index=$((${#arguments[@]} - 1))
  image="${arguments[$last_index]}"
  [[ "$image" != *failstart* ]] || exit 1
  [[ -n "$container_name" ]] || exit 2
  touch "$state_dir/containers/$container_name"
  echo "fake-$container_name"
  exit 0
fi

if [[ -n "$source_plugin_runner" || -n "$source_plugin_entry" ]]; then
  [[ -f "$source_plugin_runner" && -f "$source_plugin_entry" ]] || {
    echo "fake runtime received an incomplete source-plugin mount set" >&2
    exit 2
  }
  node_binary="$(command -v node)"
  source_plugin_runner_dir="$(cd "${source_plugin_runner%/*}" && pwd -P)"
  source_plugin_entry_dir="$(cd "${source_plugin_entry%/*}" && pwd -P)"
  source_plugin_runner="$source_plugin_runner_dir/${source_plugin_runner##*/}"
  source_plugin_entry="$source_plugin_entry_dir/${source_plugin_entry##*/}"
  permission_args=(
    --permission
    "--allow-fs-read=$source_plugin_runner_dir"
    "--allow-fs-read=$source_plugin_entry_dir"
  )
  if [[ -n "$source_plugin_data" ]]; then
    source_plugin_data="$(cd "$source_plugin_data" && pwd -P)"
    permission_args+=("--allow-fs-read=$source_plugin_data" "--allow-fs-write=$source_plugin_data")
  fi
  if [[ "$network_disabled" == "false" ]] \
    && "$node_binary" --permission --allow-net --eval "" >/dev/null 2>&1; then
    permission_args+=(--allow-net)
  fi
  if [[ -z "$source_plugin_data" ]]; then
    exec env -i LANG=C LC_ALL=C TZ=UTC "$node_binary" "${permission_args[@]}" \
      "$source_plugin_runner" "$source_plugin_entry"
  fi
  request="$(cat)"
  request="$(printf '%s' "$request" | node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const request = JSON.parse(body);
        request.dataDirectory = process.argv[1];
        process.stdout.write(JSON.stringify(request));
      });
    ' "$source_plugin_data")"
  printf '%s' "$request" \
    | env -i LANG=C LC_ALL=C TZ=UTC "$node_binary" "${permission_args[@]}" \
      "$source_plugin_runner" "$source_plugin_entry"
  exit $?
fi

if [[ -z "$workspace" || ! -d "$workspace" ]]; then
  echo "fake runtime did not receive the workspace mount" >&2
  exit 2
fi

if [[ -f "$workspace/input.txt" ]] && [[ "$(cat "$workspace/input.txt")" == "aru-runtime-check" ]]; then
  case " $* " in
    *" node -e "*) printf ok > "$workspace/node.txt" ;;
    *" python3 -c "*) printf ok > "$workspace/python.txt" ;;
    *) printf ok > "$workspace/shell.txt" ;;
  esac
  exit 0
fi

if [[ -f "$workspace/slow.flag" ]]; then
  while true; do
    sleep 1
  done
fi

printf '\211PNG\r\n\032\n\000artifact-smoke' > "$workspace/output.png"
printf 'fake container completed\n'

if [[ -f "$workspace/fail.flag" ]]; then
  printf 'fake container failed\n' >&2
  exit 7
fi
