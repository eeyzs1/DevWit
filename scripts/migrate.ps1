# migrate.ps1 — Windows PowerShell project.yaml schema 迁移脚本
# 用法：powershell migrate.ps1 -ProjectYamlPath <path-to-project.yaml>
# 框架更新时，检测 schema 版本并自动迁移

param(
    [string]$ProjectYamlPath = ".meta-harness/project.yaml"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ProjectYamlPath)) {
    Write-Error "$ProjectYamlPath not found"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MHRoot = Split-Path -Parent $ScriptDir

# schema 版本与框架版本解耦：project.yaml 结构版本独立追踪，仅在 breaking change 时递增
$TargetSchema = "2.0"

Write-Host "=== project.yaml Migration ==="
Write-Host ""

# 检测 project.yaml 的当前 schema 版本
$Content = Get-Content $ProjectYamlPath -Raw
$SchemaVersion = $null

if ($Content -match 'schema_version:\s*"([^"]+)"') {
    $SchemaVersion = $Matches[1]
} elseif ($Content -match "schema_version:\s*'([^']+)'") {
    $SchemaVersion = $Matches[1]
} elseif ($Content -match 'schema_version:\s*(\S+)') {
    $SchemaVersion = $Matches[1]
}

if (-not $SchemaVersion) {
    $SchemaVersion = "1.0.0"
    Write-Host "Detected schema: $SchemaVersion (legacy, no schema_version field)"
} else {
    Write-Host "Detected schema: $SchemaVersion"
}

Write-Host "Target schema:  $TargetSchema"
Write-Host ""

# === 迁移规则 ===
$NeedsMigration = $false

# --- v1.0.0 → v2.0.0 ---
if ($SchemaVersion -eq "1.0.0") {
    Write-Host "--- Migrating 1.0.0 -> 2.0.0 ---"
    
    $Lines = Get-Content $ProjectYamlPath
    $NewLines = @()
    
    # 检查缺失的字段
    $HasRunMode = $false
    $HasSchemaVersion = $false
    $HasPhaseSkills = $false
    
    foreach ($Line in $Lines) {
        if ($Line -match '^\s*run_mode:') { $HasRunMode = $true }
        if ($Line -match '^\s*schema_version:') { $HasSchemaVersion = $true }
        if ($Line -match '^\s*phase_skills:') { $HasPhaseSkills = $true }
    }
    
    # 重建文件内容
    foreach ($Line in $Lines) {
        $NewLines += $Line
        
        # 在 project.name 之后插入 schema_version
        if (-not $HasSchemaVersion -and $Line -match '^\s+name:\s+') {
            $NewLines += "  schema_version: `"$TargetSchema`"  # framework version for migration tracking"
            $HasSchemaVersion = $true
            $NeedsMigration = $true
            Write-Host "  + schema_version: $TargetSchema"
        }
    }
    
    # 添加 run_mode
    if (-not $HasRunMode) {
        $NewLines += ""
        $NewLines += "# === Run Mode === (migrated)"
        $NewLines += "# fast: skip brainstorm + code-review"
        $NewLines += "# full: default pipeline"
        $NewLines += "# deep: extra research + pair-review"
        $NewLines += 'run_mode: "full"  # fast | full | deep'
        $NeedsMigration = $true
        Write-Host "  + run_mode: full"
    }
    
    # 添加 phase_skills
    if (-not $HasPhaseSkills) {
        $NewLines += ""
        $NewLines += "# === Skills-Phase Mapping === (migrated from template)"
        $NewLines += "phase_skills:"
        $NewLines += "  plan:"
        $NewLines += "    - brainstorming"
        $NewLines += "    - writing-plans"
        $NewLines += "  implement:"
        $NewLines += "    - tdd"
        $NewLines += "    - subagent-driven-dev"
        $NewLines += "    - executing-plans"
        $NewLines += "  test:"
        $NewLines += "    - code-review"
        $NewLines += "    - verification"
        $NewLines += "    - systematic-debugging"
        $NewLines += "  post-audit:"
        $NewLines += "    - finishing-a-development-branch"
        $NewLines += ""
        $NewLines += "cross_phase_skills:"
        $NewLines += "  - dispatching-parallel-agents"
        $NeedsMigration = $true
        Write-Host "  + phase_skills: defaults added"
    }
    
    if ($NeedsMigration) {
        Set-Content -Path $ProjectYamlPath -Value ($NewLines -join "`r`n") -Encoding UTF8
    }
    
    Write-Host ""
}

# --- 未来的迁移在此添加 ---

if ($NeedsMigration) {
    Write-Host "Migration complete. Review $ProjectYamlPath for accuracy."
} else {
    Write-Host "Already at target schema. No migration needed."
}