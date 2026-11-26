#!/bin/sh
set -eu
cd "$(dirname "$0")"

echo "==> 构建 Linux 静态二进制"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dist/kea-dhcp-go-linux-amd64 .

echo "==> 组装发布包"
rm -rf dist/kea-dhcp-go
mkdir -p dist/kea-dhcp-go
cp dist/kea-dhcp-go-linux-amd64 dist/kea-dhcp-go/kea-dhcp-go
cp Dockerfile docker-compose.yml README.md dist/kea-dhcp-go/
cp deploy/config.example.json deploy/start.sh dist/kea-dhcp-go/
tar -czf dist/kea-dhcp-go-alpine-amd64.tar.gz -C dist kea-dhcp-go

echo "完成：dist/kea-dhcp-go-alpine-amd64.tar.gz"
