@echo off
rem Starts the CC Translator helper. Leave this window open while watching videos.
cd /d "%~dp0"
uv run python server.py %*
pause
