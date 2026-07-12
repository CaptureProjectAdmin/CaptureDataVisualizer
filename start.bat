@echo off
cd /d "%~dp0"
echo Installing dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Failed to install dependencies. Is Python installed?
  pause
  exit /b 1
)
echo.
echo Starting Capture App Visualizer at http://127.0.0.1:8765
echo Press Ctrl+C to stop.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:8765"
python -m uvicorn server:app --host 127.0.0.1 --port 8765
pause
