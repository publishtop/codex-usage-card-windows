@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0windows\setup.ps1" -Mode Install
set "setupResult=%errorlevel%"
pause
exit /b %setupResult%
