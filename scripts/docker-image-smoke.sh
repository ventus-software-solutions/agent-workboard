#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:-}"
timeout_seconds="${WORKBOARD_SMOKE_TIMEOUT_SECONDS:-45}"

if [[ -z "${image}" ]]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

if [[ ! "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "WORKBOARD_SMOKE_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi

container_name="agent-workboard-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach \
  --name "${container_name}" \
  --publish 127.0.0.1::8080 \
  --tmpfs /data:rw,noexec,nosuid,size=64m \
  --env WORKBOARD_DATA_DIR=/data \
  --env WORKBOARD_HOST=0.0.0.0 \
  --env WORKBOARD_STORAGE=sqlite \
  "${image}" >/dev/null

host_binding="$(docker port "${container_name}" 8080/tcp)"
host_port="${host_binding##*:}"
health_url="http://127.0.0.1:${host_port}/api/health"
deadline=$((SECONDS + timeout_seconds))

while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --show-error --max-time 2 "${health_url}" 2>/dev/null)" \
    && grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"${response}"; then
    echo "Image boot smoke passed: ${health_url} returned ok=true"
    exit 0
  fi

  if ! docker inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null | grep -qx true; then
    break
  fi

  sleep 1
done

echo "Image boot smoke failed for ${image}; container logs follow:" >&2
docker logs "${container_name}" >&2 || true
exit 1
