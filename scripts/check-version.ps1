# check-version.ps1 — Windows 入口（调用 check-version.py）
# 版本检查逻辑由 Python 实现（跨平台，避免 PowerShell 5.1 解析陷阱）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/check-version.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
python "$ScriptDir\check-version.py"
