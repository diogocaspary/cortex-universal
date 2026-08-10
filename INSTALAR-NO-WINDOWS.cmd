@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local\windows\install.ps1"
if errorlevel 1 pause
