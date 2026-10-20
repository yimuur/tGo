@echo off
rem ============================================================================
rem tGo Windows one-click launcher (T7.2) - thin wrapper around start.ps1.
rem This file is intentionally ASCII-only: Chinese output is handled inside
rem start.ps1 (UTF-8 BOM + console UTF-8), which avoids cmd codepage garbling.
rem Usage:  start.bat          (start or reuse running instance)
rem         start.bat -New     (ignore reuse, force a new instance on port +1)
rem ============================================================================
chcp 65001 >nul
setlocal
set "TGO_SCRIPT=%~dp0start.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%TGO_SCRIPT%" %*
set "TGO_EXIT=%ERRORLEVEL%"
if not "%TGO_EXIT%"=="0" (
  echo.
  echo [tGo] Startup failed ^(exit code %TGO_EXIT%^). Press any key to close . . .
  pause >nul
)
endlocal & exit /b %TGO_EXIT%
