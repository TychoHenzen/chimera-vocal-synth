@echo off
rem Start CHIMERA in the browser. Double-click to run; close the window or press Ctrl+C to stop.
rem It rebuilds the wasm engine first (fast when nothing changed), then serves the app at
rem http://127.0.0.1:5317 with hot reload and opens it in your browser.
cd /d "%~dp0"
call bun run wasm
if errorlevel 1 (
  echo Engine build failed.
  pause
  exit /b 1
)
call bun x vite --host 127.0.0.1 --open
echo.
echo Server stopped.
pause
