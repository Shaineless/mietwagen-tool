@echo off
setlocal
rem UTF-8, sonst werden die Umlaute in der Konsole zerlegt.
chcp 65001 >nul 2>nul
title TRACKER
cd /d "%~dp0"

echo.
echo   TRACKER
echo   Mietwagen. Vergleichen. Losfahren.
echo   ==================================
echo.

rem ---------------------------------------------------------------- ZIP
rem Wer den Quellcode als ZIP laedt, kann diese Datei im Explorer direkt im
rem ZIP doppelklicken. Windows entpackt dann nur sie allein nach Temp und
rem fuehrt sie dort aus, ohne den Rest. Die Fehlermeldung lautet dann
rem "Cannot find module ... build.mjs" und sagt nicht, woran es liegt.
if not exist "build.mjs" goto :nichtEntpackt
if not exist "package.json" goto :nichtEntpackt
if not exist "tools\serve.mjs" goto :nichtEntpackt

rem --------------------------------------------------------------- Node
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js wurde nicht gefunden.
  echo.
  echo   TRACKER braucht Node.js, um aus dem Quellcode zu starten.
  echo   Kostenlos von https://nodejs.org herunterladen, Version 20 oder neuer,
  echo   installieren und diese Datei erneut starten.
  echo.
  echo   Wer das nicht moechte: die fertige Tracker.exe unter
  echo   https://github.com/Shaineless/mietwagen-tool/releases
  echo   braucht kein Node.js.
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------- Abhaengigkeiten
rem Nach dem Herunterladen fehlt node_modules, das steht bewusst nicht im
rem Repository. Ohne playwright bricht der Dienst spaeter ab.
rem
rem PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD spart rund 700 MB: TRACKER benutzt das
rem auf dem Rechner vorhandene Chrome ueber den Debug-Anschluss und startet
rem nie einen eigenen mitgelieferten Browser.
if not exist "node_modules\playwright" (
  echo   Einmalige Vorbereitung. Es fehlen noch die benoetigten Bausteine.
  echo   Das dauert ein bis zwei Minuten und passiert nur beim ersten Mal.
  echo.
  set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Die Vorbereitung ist fehlgeschlagen, Meldung siehe oben.
    echo   Haeufigste Ursache: keine Internetverbindung.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem -------------------------------------------------------------- Bauen
echo   Baue die Oberflaeche ...
call node build.mjs
if errorlevel 1 (
  echo.
  echo   Fehler beim Bauen, Meldung siehe oben.
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
rem 127.0.0.1 statt localhost: der Dienst haengt nur an der IPv4-Adresse.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://127.0.0.1:4173/"

node tools\serve.mjs

echo.
echo   Dienst beendet.
pause
exit /b 0

rem --------------------------------------------------------------------
:nichtEntpackt
echo   Der Ordner ist nicht vollstaendig.
echo.
echo   Vermutlich wurde diese Datei direkt im ZIP-Archiv angeklickt.
echo   Windows entpackt dann nur sie allein und laesst den Rest im Archiv,
echo   deshalb fehlen die uebrigen Dateien.
echo.
echo   So geht es:
echo     1. Rechtsklick auf die heruntergeladene ZIP-Datei
echo     2. "Alle extrahieren" waehlen und einen Ordner bestaetigen
echo     3. In den entpackten Ordner gehen
echo     4. Dort "TRACKER starten.cmd" doppelklicken
echo.
echo   Aktueller Ordner:
echo     %~dp0
echo.
pause
exit /b 1
