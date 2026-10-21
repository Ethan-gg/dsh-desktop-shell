@echo off
setlocal
cd /d "%~dp0"

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0"
  exit /b 0
)

echo Electron is not installed yet. Run: npm install
pause
exit /b 1
