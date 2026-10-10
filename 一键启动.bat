@echo off
setlocal EnableExtensions
title MiMo Desktop WeChat Bridge
cd /d "%~dp0"

echo ============================================
echo   MiMo Desktop + WeChat Bridge (one-click)
echo ============================================
echo.

set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe" set "NODE=%ProgramFiles%\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe" set "NODE=%LocalAppData%\Programs\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe"

if not defined NODE (
  echo [ERROR] node not found. Install Node.js 22+ or MiMo Desktop.
  pause
  exit /b 1
)

echo [1/4] Node: %NODE%
"%NODE%" -v

if not exist "dist\cli\index.js" (
  echo [2/4] First run: building project...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm not found.
    pause
    exit /b 1
  )
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    echo [ERROR] build failed
    pause
    exit /b 1
  )
) else (
  echo [2/4] dist already exists, skip build
)

echo [3/4] Checking WeChat login...
"%NODE%" dist/cli/index.js status
if errorlevel 1 (
  echo.
  echo Not logged in, opening QR login...
  "%NODE%" dist/cli/index.js login
  if errorlevel 1 (
    echo [ERROR] login failed
    pause
    exit /b 1
  )
)

echo.
echo [4/4] Starting WeChat bridge. Close this window to stop.
echo       In WeChat try: hello / /help / /model
echo ============================================
echo.

"%NODE%" dist/cli/index.js run
set "CODE=%ERRORLEVEL%"

echo.
echo ============================================
echo Bridge exited with code %CODE%
echo Double-click this script again to restart.
echo ============================================
pause
exit /b %CODE%
