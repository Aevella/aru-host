#!/usr/bin/env bash
set -Eeuo pipefail

state_dir="${ARU_FAKE_RUNTIME_STATE_DIR:-${TMPDIR:-/tmp}/aru-fake-container-runtime}"
mkdir -p "$state_dir/containers" "$state_dir/volumes"

command="${1:-}"
shift || true

case "$command" in
  --version)
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
    type=bind,src=*,dst=/workspace,rw)
      workspace="${argument#type=bind,src=}"
      workspace="${workspace%,dst=/workspace,rw}"
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

if [[ -z "$workspace" || ! -d "$workspace" ]]; then
  echo "fake runtime did not receive the workspace mount" >&2
  exit 2
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
