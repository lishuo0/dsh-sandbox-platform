#!/usr/bin/env bash
# 一键启动本地数据库、脑和平台。数据库在 Docker 里。
#   ./scripts/dev.sh
#   ./scripts/dev.sh stop
#   ./scripts/dev.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN="$(cd "$ROOT/.." && pwd)/dsh-sandbox-brain"
RUN="$ROOT/var/run"
LOG="$ROOT/var/log"
CMD="${1:-start}"

mkdir -p "$RUN" "$LOG" "$ROOT/var/objects"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.yml" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$ROOT/docker-compose.yml" -p dsh-sandbox "$@"
  else
    echo "没有 docker compose。先安装并启动 Docker。" >&2
    exit 1
  fi
}

port_open() {
  node -e 'const n=require("net"); const s=n.connect(Number(process.argv[1]), "127.0.0.1", () => { s.end(); process.exit(0) }); s.on("error", () => process.exit(1))' "$1"
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_one() {
  local name="$1"
  local pidfile="$RUN/$name.pid"
  if [[ ! -f "$pidfile" ]]; then
    return
  fi
  local pid
  pid="$(cat "$pidfile")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

start_node() {
  local name="$1"
  local dir="$2"
  local port="$3"
  if port_open "$port"; then
    echo "$name 已在 $port 监听"
    return
  fi
  if [[ ! -d "$dir" ]]; then
    echo "没有找到 $dir，跳过 $name" >&2
    return
  fi
  echo "启动 $name"
  (
    cd "$dir"
    nohup npm start >> "$LOG/$name.log" 2>&1 &
    echo $! > "$RUN/$name.pid"
  )
  local i pid
  for i in $(seq 1 90); do
    if port_open "$port"; then
      echo "$name 就绪 :$port"
      return
    fi
    pid="$(cat "$RUN/$name.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "$name 退出了，最后日志：" >&2
      tail -n 50 "$LOG/$name.log" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "$name 在 90 秒内没有监听 $port，最后日志：" >&2
  tail -n 50 "$LOG/$name.log" >&2 || true
  exit 1
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "没有 docker。安装并启动 Docker 后再执行 ./scripts/dev.sh" >&2
    exit 1
  fi
  if docker info >/dev/null 2>&1; then
    return
  fi
  if command -v colima >/dev/null 2>&1; then
    echo "启动 Colima"
    colima start
    return
  fi
  echo "Docker 没有在运行。" >&2
  exit 1
}

start_database() {
  ensure_docker
  echo "启动数据库"
  compose up -d
  local i
  for i in $(seq 1 60); do
    if compose exec -T postgres pg_isready -U dsh -d dsh >/dev/null 2>&1; then
      echo "数据库就绪 :5432"
      return
    fi
    sleep 1
  done
  echo "数据库在 60 秒内没有就绪" >&2
  compose logs --tail 40 postgres >&2 || true
  exit 1
}

case "$CMD" in
  stop)
    stop_one platform
    stop_one brain
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      compose stop
    fi
    echo "已停止"
    ;;
  status)
    port_open 5432 && echo "postgres :5432" || echo "postgres 未监听"
    port_open 8080 && echo "brain    :8080" || echo "brain 未监听"
    port_open 3000 && echo "platform :3000" || echo "platform 未监听"
    ;;
  start)
    node "$ROOT/scripts/ensure-config.mjs"
    start_database
    start_node brain "$BRAIN" 8080
    start_node platform "$ROOT" 3000
    echo "平台 http://127.0.0.1:3000"
    echo "脑   http://127.0.0.1:8080"
    echo "日志 $LOG"
    ;;
  *)
    echo "用法: ./scripts/dev.sh [start|stop|status]" >&2
    exit 1
    ;;
esac
