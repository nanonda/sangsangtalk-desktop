<#
.SYNOPSIS
  상상톡 Zulip 스택을 Zulip 공식 백업 도구(manage.py backup)로 백업한다.

.DESCRIPTION
  1. 컨테이너 안에서 manage.py backup 으로 tar.gz를 만든다(DB + 업로드 + /etc/zulip 설정).
  2. docker compose cp 로 꺼내 <BackupRoot>\<yyyyMMdd-HHmmss>\ 에 저장한다.
  3. 컨테이너 안 임시 파일을 지운다.
  4. RetentionDays 일보다 오래된 백업 폴더(이름이 yyyyMMdd-HHmmss 형식인 것만)를 지운다.
  로그는 <BackupRoot>\backup.log 에 덧붙인다. 실패하면 종료 코드 1.
  이 스크립트는 .env 나 secrets 를 읽거나 출력하지 않는다.
  (단, 백업 tar.gz 자체에는 /etc/zulip/zulip-secrets.conf 가 들어 있으므로 백업 폴더 접근 권한에 주의한다.)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\SangsangTalk\ops\backup.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\SangsangTalk\ops\backup.ps1 -BackupRoot D:\zulip-backup -RetentionDays 14
#>
[CmdletBinding()]
param(
    [string]$BackupRoot = 'C:\SangsangTalk-backup',
    [ValidateRange(1, 3650)]
    [int]$RetentionDays = 30,
    # compose.yaml 이 있는 폴더. 기본은 이 스크립트의 상위 폴더(C:\SangsangTalk).
    [string]$ComposeDir = '',
    [string]$Service = 'zulip'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# PS 5.1 에서는 param 기본값 안에서 $PSScriptRoot 가 비어 있을 수 있어 본문에서 정한다.
if (-not $ComposeDir) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ComposeDir = Split-Path -Parent $scriptDir
}

$startedAt = Get-Date
$stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
$logFile = Join-Path $BackupRoot 'backup.log'
$composeFile = Join-Path $ComposeDir 'compose.yaml'
$containerFile = "/tmp/sangsangtalk-backup-$stamp.tar.gz"
$targetDir = Join-Path $BackupRoot $stamp
$targetFile = Join-Path $targetDir "zulip-backup-$stamp.tar.gz"

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($Level -eq 'ERROR') { [Console]::Error.WriteLine($line) } else { Write-Host $line }
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
}

# docker compose 를 실행하고 출력(표준오류 포함)을 로그에 남긴다. 종료 코드를 돌려준다.
function Invoke-Compose {
    param([string[]]$Arguments)
    $all = @('compose', '-f', $composeFile) + $Arguments
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # PS 5.1: 네이티브 stderr 를 오류로 취급하지 않게
    try {
        $output = & docker @all 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    foreach ($l in $output) { if ($l -and $l.Trim()) { Write-Log "  docker> $l" } }
    return $code
}

$containerFileCreated = $false
$exitCode = 0
try {
    if (-not (Test-Path -LiteralPath $BackupRoot)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }
    Write-Log "백업 시작: compose=$composeFile, 대상=$targetDir, 보관=${RetentionDays}일"

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'docker 명령을 찾을 수 없습니다. Docker Desktop이 설치·실행 중인지 확인하세요.'
    }
    if (-not (Test-Path -LiteralPath $composeFile)) {
        throw "compose.yaml 을 찾을 수 없습니다: $composeFile"
    }

    # 1) 서비스 실행 확인
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $running = & docker compose -f $composeFile ps --status running --services 2>$null
    $ErrorActionPreference = $prev
    if (-not (@($running) -contains $Service)) {
        throw "Zulip 컨테이너('$Service')가 실행 중이 아닙니다. 'docker compose up -d' 후 다시 시도하세요."
    }

    # 2) 컨테이너 안에서 공식 백업 생성
    Write-Log 'manage.py backup 실행 중...'
    $containerFileCreated = $true
    $code = Invoke-Compose @('exec', '-T', '-u', 'zulip', $Service,
        '/home/zulip/deployments/current/manage.py', 'backup', "--output=$containerFile")
    if ($code -ne 0) { throw "Zulip 백업 명령이 실패했습니다(종료 코드 $code)." }

    # 3) 호스트로 복사
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    $code = Invoke-Compose @('cp', "${Service}:$containerFile", $targetFile)
    if ($code -ne 0) { throw "백업 파일을 컨테이너에서 꺼내지 못했습니다(종료 코드 $code)." }
    if (-not (Test-Path -LiteralPath $targetFile)) { throw "복사된 백업 파일이 없습니다: $targetFile" }
    $size = (Get-Item -LiteralPath $targetFile).Length
    if ($size -le 0) { throw "백업 파일 크기가 0입니다: $targetFile" }

    # 4) 내용 목록만 검사(압축이 깨지지 않았는지, DB 덤프가 들어 있는지). 파일 내용은 읽지 않는다.
    $tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tarExe) {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $entries = & $tarExe.Source -tzf $targetFile 2>$null
        $tarCode = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($tarCode -ne 0) { throw '백업 파일이 손상되었습니다(tar 목록 읽기 실패).' }
        if (-not (@($entries) -match '^zulip-backup/database/')) {
            throw '백업 파일에 데이터베이스 덤프(zulip-backup/database)가 없습니다.'
        }
    }
    Write-Log ("백업 파일 저장: {0} ({1:N0} 바이트, {2:N1} MB)" -f $targetFile, $size, ($size / 1MB))

    # 4-1) 상상톡 쪽지 인덱스(web/data/notes.json) 사본. 없으면 경고만 남기고 계속한다.
    $notesFile = Join-Path $ComposeDir 'web\data\notes.json'
    if (Test-Path -LiteralPath $notesFile -PathType Leaf) {
        try {
            Copy-Item -LiteralPath $notesFile -Destination (Join-Path $targetDir 'notes.json') -Force
            Write-Log ("쪽지 인덱스 사본 저장: {0} ({1:N0} 바이트)" -f (Join-Path $targetDir 'notes.json'), (Get-Item -LiteralPath $notesFile).Length)
        } catch {
            Write-Log "쪽지 인덱스를 복사하지 못했습니다(백업은 계속): $($_.Exception.Message)" 'WARN'
        }
    } else {
        Write-Log "쪽지 인덱스 파일이 없어 건너뜁니다: $notesFile" 'WARN'
    }

    # 5) 오래된 백업 정리(이름이 yyyyMMdd-HHmmss 인 폴더만 대상)
    $cutoff = $startedAt.AddDays(-$RetentionDays)
    Get-ChildItem -LiteralPath $BackupRoot -Directory | ForEach-Object {
        $d = [datetime]::MinValue
        if ($_.Name -match '^\d{8}-\d{6}$' -and
            [datetime]::TryParseExact($_.Name, 'yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$d) -and
            $d -lt $cutoff) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
            Write-Log "오래된 백업 삭제: $($_.FullName)"
        }
    }

    $elapsed = (Get-Date) - $startedAt
    Write-Log ("백업 완료 ({0:N0}초)" -f $elapsed.TotalSeconds)
} catch {
    $exitCode = 1
    Write-Log "백업 실패: $($_.Exception.Message)" 'ERROR'
    # 실패한 이번 회차의 불완전한 폴더는 지운다
    if (Test-Path -LiteralPath $targetDir) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally {
    # 컨테이너 안 임시 파일 정리
    if ($containerFileCreated) {
        $code = Invoke-Compose @('exec', '-T', '-u', 'zulip', $Service, 'rm', '-f', $containerFile)
        if ($code -ne 0) {
            Write-Log "컨테이너 안 임시 파일을 지우지 못했습니다: $containerFile" 'ERROR'
            if ($exitCode -eq 0) { $exitCode = 1 }
        }
    }
}
exit $exitCode
