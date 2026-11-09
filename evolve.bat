@echo off
rem Evolve the voice toward the CSD recordings. Double-click to start; close the window or press
rem Ctrl+C to stop. Running it again picks up where it stopped.
rem Every 30 minutes it moves to a new phrase of a new song, so what it learns holds across songs.
rem Extra options are passed on, for example: evolve.bat --rotate 10 --pop 48 --minutes 240
rem Progress: out\evolve\rotating\dashboard.html (opens by itself after a minute, refreshes every 20 s)
cd /d "%~dp0"
cargo build --release -p chimera-cli
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
set OUT=out\evolve\rotating
set RESUME=
if exist "%OUT%\state.json" set RESUME=--resume %OUT%
start "" powershell -WindowStyle Hidden -Command "Start-Sleep 60; Start-Process '%CD%\%OUT%\dashboard.html'"
target\release\chimera.exe evolve --out %OUT% %RESUME% %*
echo.
echo Stopped. Run evolve.bat again to continue.
pause
