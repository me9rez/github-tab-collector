@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node.js 18 或更高版本： https://nodejs.org/
  pause
  exit /b 1
)

echo 启动 GitHub Tab Collector 中继服务...
node relay\server.mjs
pause
