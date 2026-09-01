@echo off
setlocal
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
echo   Starte den lokalen Dienst und oeffne den Browser ...
echo.
echo   Zum Beenden: dieses Fenster schliessen.
echo.

rem Browser oeffnen, sobald der Dienst gleich lauscht.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:4173/"

node tools\serve.mjs

echo.
echo   Dienst beendet.
pause
