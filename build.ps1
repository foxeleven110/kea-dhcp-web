param(
  [string]$Version = "1.0.0"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "==> 构建 Windows 调试版"
go build -trimpath -ldflags "-s -w" -o "dist\kea-dhcp-go.exe" .

Write-Host "==> 交叉编译 Linux/amd64 静态二进制（Alpine 可用）"
$env:CGO_ENABLED = "0"
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -trimpath -ldflags "-s -w" -o "dist\kea-dhcp-go-linux-amd64" .
Remove-Item Env:\CGO_ENABLED, Env:\GOOS, Env:\GOARCH -ErrorAction SilentlyContinue

Write-Host "==> 组装发布包"
$pkg = "dist\kea-dhcp-go"
if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
Copy-Item "dist\kea-dhcp-go-linux-amd64" "$pkg\kea-dhcp-go"
Copy-Item "Dockerfile", "docker-compose.yml", "README.md" $pkg
Copy-Item "deploy\config.example.json", "deploy\start.sh" $pkg

if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
  tar -czf "dist\kea-dhcp-go-alpine-amd64.tar.gz" -C "dist" "kea-dhcp-go"
} else {
  Compress-Archive -Path "$pkg\*" -DestinationPath "dist\kea-dhcp-go-alpine-amd64.zip" -Force
}

Write-Host "完成：dist\kea-dhcp-go.exe、dist\kea-dhcp-go-linux-amd64、dist\kea-dhcp-go-alpine-amd64.tar.gz"
