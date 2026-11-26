#!/bin/sh
set -eu
# Alpine/容器内启动脚本
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
mkdir -p "$DATA_DIR"
exec "$APP_DIR/kea-dhcp-go" -addr 0.0.0.0:8080 -config "$DATA_DIR/config.json" -open=false
