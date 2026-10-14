@echo off
REM Daily state snapshot + deploy-drift canary + Telegram digest. Scheduled ~5AM (Task Scheduler).
REM Runs the copy next to this file, so the task follows whichever checkout it points at.
set DAILY_TELEGRAM=1
node "%~dp0daily-state-snapshot.mjs"
exit /b %ERRORLEVEL%
