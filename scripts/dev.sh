#!/usr/bin/env bash
# 管理平台本地开发：数据库和平台进程。
# config.yaml 默认 database.file（SQLite，不需要安装数据库和 Docker）；
# 配了 database.url 才启动 PostgreSQL（优先 Docker，没有 Docker 时用本地 PostgreSQL）。
#   ./scripts/dev.sh
#   ./scripts/dev.sh stop
#   ./scripts/dev.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/var/run"
LOG="$ROOT/var/log"
PG_DIR="$ROOT/var/pg"
CMD="${1:-start}"
DB="$(node "$ROOT/scripts/ensure-config.mjs" --db)"
DB_KIND="${DB%% *}"
DB_FILE="${DB#* }"

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
    echo "没有找到 ${dir}，跳过 $name" >&2
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
  echo "$name 在 90 秒内没有监听 ${port}，最后日志：" >&2
  tail -n 50 "$LOG/$name.log" >&2 || true
  exit 1
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

ensure_docker() {
  if docker_ready; then
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  if command -v colima >/dev/null 2>&1; then
    echo "启动 Colima"
    colima start
    return 0
  fi
  return 1
}

local_pg_ready() {
  command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1 &&
    command -v pg_isready >/dev/null 2>&1 && command -v createdb >/dev/null 2>&1
}

start_local_database() {
  echo "启动数据库（本地 PostgreSQL，${PG_DIR}）"
  if [[ ! -f "$PG_DIR/PG_VERSION" ]]; then
    LC_ALL=C initdb -D "$PG_DIR" -U dsh --auth-local=trust --auth-host=trust -E UTF8 --locale=C >/dev/null
  fi
  if ! pg_ctl -D "$PG_DIR" status >/dev/null 2>&1; then
    LC_ALL=C pg_ctl -D "$PG_DIR" -l "$LOG/postgres.log" -o "-p 5432 -k /tmp" start >/dev/null
  fi
  local i
  for i in $(seq 1 60); do
    pg_isready -h 127.0.0.1 -p 5432 -U dsh >/dev/null 2>&1 && break
    sleep 1
  done
  if ! pg_isready -h 127.0.0.1 -p 5432 -U dsh >/dev/null 2>&1; then
    echo "数据库在 60 秒内没有就绪，日志 $LOG/postgres.log" >&2
    exit 1
  fi
  createdb -h 127.0.0.1 -p 5432 -U dsh dsh 2>/dev/null || true
  echo "数据库就绪 :5432"
}

start_database() {
  if port_open 5432; then
    echo "数据库就绪 :5432"
    return
  fi
  if ! docker_ready && ensure_docker; then
    :
  fi
  if docker_ready; then
    echo "启动数据库（Docker）"
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
  fi
  if local_pg_ready; then
    start_local_database
    return
  fi
  echo "没有 Docker，也没有本地 PostgreSQL。安装 Docker，或 brew install postgresql@16。" >&2
  exit 1
}

case "$CMD" in
  stop)
    stop_one platform
    if [[ "$DB_KIND" == "postgres" ]]; then
      if docker_ready; then
        compose stop
      elif [[ -f "$PG_DIR/PG_VERSION" ]] && pg_ctl -D "$PG_DIR" status >/dev/null 2>&1; then
        pg_ctl -D "$PG_DIR" stop -m fast >/dev/null
      fi
    fi
    echo "已停止"
    ;;
  status)
    if [[ "$DB_KIND" == "sqlite" ]]; then
      echo "sqlite $DB_FILE"
    else
      port_open 5432 && echo "postgres :5432" || echo "postgres 未监听"
    fi
    port_open 3000 && echo "platform :3000" || echo "platform 未监听"
    ;;
  start)
    node "$ROOT/scripts/ensure-config.mjs"
    if [[ "$DB_KIND" == "sqlite" ]]; then
      echo "数据库 SQLite（${DB_FILE}），不需要启动数据库"
    else
      start_database
    fi
    start_node platform "$ROOT" 3000
    echo "平台 http://127.0.0.1:3000"
    echo "日志 $LOG"
    ;;
  *)
    echo "用法: ./scripts/dev.sh [start|stop|status]" >&2
    exit 1
    ;;
esac
