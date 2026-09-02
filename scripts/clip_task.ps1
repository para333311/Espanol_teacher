# 매일 12:05 KST 예약작업이 부른다. 오늘 문장 클립을 찾아 워커로 넘긴다.
# 등록: schtasks /Create /TN "EspanolClip" /SC DAILY /ST 12:05 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\msi\Espanol_teacher\scripts\clip_task.ps1"
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo "state\clip.log"
New-Item -ItemType Directory -Force (Join-Path $repo "state") | Out-Null
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
"==== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -Append -Encoding utf8 $log
& python (Join-Path $repo "scripts\daily_clip.py") 2>&1 | Out-File -Append -Encoding utf8 $log
"exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 $log
