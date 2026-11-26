# Kea DHCP 管理台（Go）

基于 Go 标准库实现的 Kea DHCPv4 Web 管理台，后端直接对接 Kea Control Agent 的 REST 命令 API，前端为单页应用，构建产物为单二进制（前端资源已内嵌）。

## 功能

| 模块 | 能力 | Kea 命令 |
| --- | --- | --- |
| 概览 | 版本、运行时长、DHCP 状态、子网数、线程池、配置版本 | `version-get` `status-get` `config-get` |
| 子网与地址池 | subnet4 新建/编辑/删除，地址池增删，保留地址增删，DHCP 中继地址（`relay.ip-addresses`）配置 | `config-get` `config-test` `config-set` `config-write` |
| 租约管理 | 一键查询全部（无参数）/按 IP/MAC/主机名/ClientID 查询；修改 MAC（`lease4-update`）；修改 IP（新增迁移+删除旧租约，保留 MAC/主机名）；删除与按子网清空 | `lease4-get-all` `lease4-update` `lease4-add` `lease4-del` `lease4-wipe` |
| 配置管理 | 查看、格式化、校验、应用、落盘、下载 JSON | `config-get` `config-test` `config-set` `config-write` |
| 运行统计 | 统计项查看、单项重置、全部重置/清除 | `statistic-*` |
| 命令控制台 | 任意命令执行与执行历史 | 全部 `list-commands` |
| 服务控制 | DHCP 启停、配置重载、进程关闭（二次确认） | `dhcp-enable` `dhcp-disable` `config-reload` `shutdown` |
| 连接设置 | 热更新 API 地址与认证信息并持久化 | — |

所有配置类写操作均走 `config-test → config-set → config-write`，校验失败不会应用。

## 目录结构

```
kea-dhcp-go/
├── main.go                  # 启动、参数、静态资源内嵌
├── internal/
│   ├── config/              # 配置加载、环境变量、0600 持久化
│   ├── kea/                 # Kea REST 客户端（Basic Auth、错误映射）
│   └── api/                 # 路由、中间件、各业务接口
├── web/                     # 前端单页（HTML/CSS/原生 JS）
├── deploy/                  # 示例配置与容器启动脚本
├── Dockerfile
├── docker-compose.yml
├── build.ps1 / build.sh     # 一键构建与打包
└── dist/                    # 构建产物
```

## 本地调试

前置：Go 1.23+。

```bash
# 开发模式：前端从 web 目录读取，改完刷新即可生效
go run . -dev -open

# 或编译后运行
go build -o kea-dhcp-go.exe .
./kea-dhcp-go.exe -open
```

启动后自动打开 `http://127.0.0.1:8080`。默认只监听本机，避免管理接口暴露到网络。

常用参数：

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `-addr` | 监听地址 | `127.0.0.1:8080` |
| `-kea-url` | Kea Control Agent 地址 | `http://kea-dhcp4:8000` |
| `-kea-user` / `-kea-pass` | Kea API 凭证 | 见 `config.json` |
| `-config` | 配置文件路径 | `config.json` |
| `-open` | 启动后打开浏览器 | `true` |
| `-dev` | 前端资源走磁盘目录 | `false` |
| `-web` | 开发模式前端目录 | `web` |

配置优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。环境变量：`KEA_LISTEN`、`KEA_URL`、`KEA_USER`、`KEA_PASS`、`KEA_OPEN_BROWSER`。

> `config.json` 含 API 凭证，已按 0600 写入，并加入 `.gitignore`。页面上的“连接设置”会更新内存连接并持久化该文件。

## HTTP 接口

统一前缀 `/api`，JSON 进出，错误返回 `{"error": "..."}` 并附带合适的状态码（Kea 业务错误 400、命令不支持 501、连接异常 502）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 本地存活探测 |
| GET/POST | `/connection` | 读取/更新 Kea 连接 |
| POST | `/connection/test` | 使用指定或当前连接测试 |
| GET | `/overview` | 概览数据 |
| GET | `/config` | 当前 Dhcp4 配置 |
| GET | `/config/download` | 下载配置文件 |
| POST | `/config/test` | 配置校验 |
| POST | `/config/apply` | 校验并应用（可选落盘/重载） |
| GET | `/subnets` | 子网列表 |
| POST | `/subnets` | 新建子网 |
| GET/PUT/DELETE | `/subnets/{id}` | 查询/更新/删除子网 |
| POST/DELETE | `/subnets/{id}/pools` | 添加/删除地址池 |
| POST/DELETE | `/subnets/{id}/reservations` | 添加/删除保留地址 |
| GET | `/leases/capability` | lease_cmds 能力探测 |
| POST | `/leases/query` | 一键全部（无参数）/按 IP/主机名/MAC/ClientID/子网查询 |
| POST | `/leases/modify` | 修改租约：`mode=mac`（lease4-update）/ `mode=ip`（add+del 迁移） |
| DELETE | `/leases?ip=` | 删除租约 |
| POST | `/leases/wipe` | 清空子网租约 |
| GET | `/stats` | 统计项 |
| POST | `/stats/reset` | `reset` / `reset-all` / `remove-all` |
| GET | `/commands` | 可用命令列表 |
| POST | `/command` | 执行任意命令 |
| POST | `/server/action` | `enable` / `disable` / `reload` / `shutdown` |

## Alpine 部署

产物为 `CGO_ENABLED=0` 静态二进制，可直接在 Alpine 运行：

```bash
# 构建（Windows）
.\build.ps1
# 构建（Linux/macOS）
./build.sh
```

输出：

- `dist/kea-dhcp-go.exe` — Windows 本机调试
- `dist/kea-dhcp-go-linux-amd64` — Linux/amd64 静态二进制
- `dist/kea-dhcp-go-alpine-amd64.tar.gz` — 含二进制、Dockerfile、compose、示例配置的发布包

直接运行：

```bash
tar -xzf kea-dhcp-go-alpine-amd64.tar.gz
cd kea-dhcp-go
cp config.example.json config.json   # 填写凭证
chmod +x kea-dhcp-go start.sh
KEA_PASS='***' ./kea-dhcp-go -addr 0.0.0.0:80 -config config.json -open=false
```

Docker：

```bash
cp .env.example .env    # 填写 KEA_PASS
docker compose up -d --build
# 访问 http://服务器IP:80
```

容器内使用非 root 用户运行，配置持久化在 `kea-data` 卷的 `/data/config.json`。

## 已知限制

- 租约管理依赖 Kea 的 `lease_cmds` 钩子（`lease4-*` 命令）。当前服务器已启用，修改 MAC / 修改 IP 保存后立即在服务器生效，客户端重新申请地址时获得修改后的结果。若钩子未启用，页面会显示能力提示并禁用相关操作。
- 修改 IP 的实现为“在新 IP 创建租约（保留 MAC、主机名、租期）+ 删除旧 IP 租约”两步；若新 IP 已被占用，第一步失败则不会影响原租约。
- `shutdown` 会直接终止 Kea 进程，页面要求输入 `SHUTDOWN` 二次确认；生产环境请确保有 systemd/容器重启策略。
- 管理台默认无登录鉴权，依赖“仅监听 127.0.0.1”保护。若要对外提供服务，请置于反向代理后并增加认证与访问控制。
- kea-dhcp4的Docker运行建议，使用镜像docker.cloudsmith.io/isc/docker/kea-dhcp4
```
docker run -d   --name kea-dhcp4   --network my_macvlan   -v /opt/kea-config:/etc/kea   -v /opt/kea-data:/var/lib/kea   --cap-add=NET_ADMIN   --cap-add=NET_RAW   docker.cloudsmith.io/isc/docker/kea-dhcp4
```
## 安全建议

- `config.json`、`.env` 含凭证，不要提交版本库或放进镜像。
- 对外暴露时使用 HTTPS 反向代理，限制来源网段。
- 通过 `config-set` 应用配置前先确认 `config-test` 结果，重要变更建议先备份配置文件。
- kea-* 是kea-dhcp配置文件示例

