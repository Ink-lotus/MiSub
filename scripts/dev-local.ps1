# 本地验收环境启动脚本
#
# 起两个进程：
#   1. wrangler pages dev  :8787  —— 后端 API + 本地 KV（miniflare，落盘 .wrangler/state）
#   2. vite dev            :5173  —— 前端，按 vite.config.js 把 /api 反代到 8787
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\dev-local.ps1
#
# 登录密码来自 .dev.vars 的 ADMIN_PASSWORD，当前为 misub-local-dev。
# 停止：关掉弹出的两个窗口，或 Get-Process node | Stop-Process

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root '.dev.vars'))) {
    Write-Host '缺少 .dev.vars，先创建它再运行本脚本。' -ForegroundColor Red
    exit 1
}

# 两个必需的参数，都踩过坑：
#
# --show-interactive-dev-session false
#   它默认在“终端看起来可交互”时为 true，而 cmd 窗口正是如此。那个交互式会话会
#   占住负责转发静态资源的父进程 —— workerd 照常绑定 8787，但每个请求都卡在它后面，
#   表现为端口在听、请求全超时。
#
# --compatibility-date 2024-04-01
#   pages dev 不读 wrangler-cf-pages.toml，缺省会把兼容日期设成“今天”，而随包的
#   workerd 只支持到 2026-05-27，于是运行时直接拒绝启动。这里显式对齐项目配置里
#   的日期，避免为此升级 wrangler 而动 package-lock.json。
$backendLog = Join-Path $root 'wrangler-dev.log'
$viteLog = Join-Path $root 'vite-dev.log'

Write-Host '启动后端 wrangler pages dev :8787 ...' -ForegroundColor Cyan
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "npx wrangler pages dev public --port 8787 --kv MISUB_KV --compatibility-date 2024-04-01 --compatibility-flag nodejs_compat --show-interactive-dev-session false > `"$backendLog`" 2>&1" `
    -WorkingDirectory $root -WindowStyle Hidden

Write-Host '等待后端就绪 ...' -ForegroundColor Cyan
Start-Sleep -Seconds 18

Write-Host '启动前端 vite dev :5173 ...' -ForegroundColor Cyan
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "npx vite --port 5173 > `"$viteLog`" 2>&1" `
    -WorkingDirectory $root -WindowStyle Hidden

Start-Sleep -Seconds 8
Write-Host ''
Write-Host '打开 http://127.0.0.1:5173/' -ForegroundColor Green
Write-Host '登录密码 misub-local-dev' -ForegroundColor Green
Write-Host ''
Write-Host '验收路径：设置 → 服务设置 → 自定义规则模板 → 顶栏「🎨 可视化编辑」' -ForegroundColor Yellow
