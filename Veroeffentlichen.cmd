@echo off
rem  Doppelklick: baut die EXE (falls noetig), schiebt die Commits hoch und
rem  legt das GitHub-Release samt Datei an. Mehr ist nicht zu tun.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\veroeffentlichen.ps1"
echo.
pause
