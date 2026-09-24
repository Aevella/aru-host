#!/usr/bin/env bash
# Recovery entry for released installers that keep reinstalling a fixed ref.
# Uses the new control script with the existing installation profile and data.
set -Eeuo pipefail
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
ref="$(curl --fail --silent --show-error --location https://api.github.com/repos/Aevella/aru-host/releases/latest | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const r=JSON.parse(s);if(r.draft||r.prerelease||!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(r.tag_name))process.exit(1);process.stdout.write(r.tag_name)})')"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location "https://raw.githubusercontent.com/Aevella/aru-host/$ref/aru-selfhostctl" -o "$temporary/control"
bash "$temporary/control" upgrade --ref "$ref"
