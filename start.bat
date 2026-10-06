@echo off
rem One double-click starts everything, from any location.
rem
rem %~dp0 is the folder this .bat lives in, so it never matters where the
rem terminal happens to be - which is exactly the mistake this file removes:
rem "npm run ..." only works from the project folder, and running it from
rem the home directory fails with a confusing ENOENT about package.json.
rem
rem Kept pure ASCII on purpose: cmd reads .bat files in the system codepage
rem (CP949 on Korean Windows), so UTF-8 Korean text here would come out mangled.

cd /d "%~dp0"

if not exist node_modules (
  echo [setup] node_modules not found - running npm install first...
  call npm install
)

start "Bass Practice - app (dev server)" cmd /k npm run dev
start "Bass Practice - sidecar (demucs)" cmd /k npm run sidecar

rem Give the dev server a moment, then open the browser at the right address
rem (http, not https - that s hurt before too).
timeout /t 4 /nobreak >nul
start http://localhost:5173/

echo.
echo Two windows opened: the app server and the sidecar.
echo Close those windows (or Ctrl+C in them) to stop.
