param(
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"
$appName = "Ganga Digital Automation"

Write-Host "Stopping running app process..." -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -like "*Ganga Digital Automation*" -or $_.ProcessName -eq "Ganga Digital Automation" } | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force } catch { }
}

$possibleInstallDirs = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Ganga Digital Automation"),
  (Join-Path $env:LOCALAPPDATA "ganga-digital-automation"),
  (Join-Path $env:LOCALAPPDATA "Ganga Digital Automation")
)

$squirrelUpdateExe = Join-Path $env:LOCALAPPDATA "ganga-digital-automation\Update.exe"
if (Test-Path $squirrelUpdateExe) {
  Write-Host "Running old Squirrel uninstaller..." -ForegroundColor Yellow
  try {
    Start-Process -FilePath $squirrelUpdateExe -ArgumentList "--uninstall" -Wait -NoNewWindow
  } catch {
    Write-Warning "Squirrel uninstall command failed: $($_.Exception.Message)"
  }
}

foreach ($dir in $possibleInstallDirs) {
  if (Test-Path $dir) {
    Write-Host "Removing old install folder: $dir" -ForegroundColor Yellow
    try {
      Remove-Item $dir -Recurse -Force
    } catch {
      Write-Warning "Could not remove ${dir}: $($_.Exception.Message)"
    }
  }
}

if ($InstallerPath -and (Test-Path $InstallerPath)) {
  Write-Host "Launching new installer: $InstallerPath" -ForegroundColor Green
  Start-Process -FilePath $InstallerPath
} else {
  Write-Host "Cleanup complete. Pass -InstallerPath <path-to-new-exe> to auto-launch installer." -ForegroundColor Green
}
