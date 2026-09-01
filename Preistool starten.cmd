@echo off
setlocal
rem UTF-8, sonst werden die Umlaute in der Konsole zerlegt.
chcp 65001 >nul 2>nul
title Mietwagen-Preistool
cd /d "%~dp0"

echo.
echo   Mietwagen-Preistool
echo   ===================
echo.

rem Node vorhanden?
where node >nul 2>nul
if errorlevel 1 (
  echo   FEHLER: Node.js wurde nicht gefunden.
  echo.
  echo   Node.js von https://nodejs.org herunterladen und installieren,
  echo   danach diese Datei erneut starten.
  echo.
  pause
  exit /b 1
)

echo   Baue die Oberflaeche ...
call node build.mjs
if errorlevel 1 (
  echo.
  echo   FEHLER beim Bauen. Meldung siehe oben.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starte den Dienst und oeffne den Browser ...
echo   Zum Beenden: dieses Fenster schliessen.
echo.

rem Kurz warten, dann den Browser oeffnen. ping statt timeout, weil timeout
rem abbricht, sobald die Eingabe umgeleitet ist.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:4173/"

node tools\serve.mjs

echo.
echo   Dienst beendet.
pause
