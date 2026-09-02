# Veroeffentlicht die aktuelle Fassung als GitHub-Release.
#
# Ein Durchlauf macht alles, was zum Hochladen noetig ist:
#
#   1. baut die EXE neu, wenn eine Quelldatei juenger ist als die vorhandene
#   2. schiebt offene Commits hoch
#   3. legt das Release an (Version aus package.json)
#   4. haengt die EXE als Datei an und nennt am Ende die Adresse
#
# Die Zugangsdaten kommen aus dem Windows-Anmeldeinformationsspeicher, in dem
# Git sie beim ersten Push abgelegt hat. Sie werden nirgends angezeigt und
# nirgends gespeichert — das Skript reicht sie nur an GitHub weiter. Wer das
# nicht will, laedt die Datei von Hand unter Releases hoch.

$ErrorActionPreference = 'Stop'
$wurzel = Split-Path -Parent $PSScriptRoot
Set-Location $wurzel

function Schritt($text) { Write-Host "`n  $text" -ForegroundColor Cyan }
function Gut($text)     { Write-Host "  $text" -ForegroundColor Green }
function Schlecht($text){ Write-Host "`n  $text" -ForegroundColor Red }

Write-Host ""
Write-Host "  TRACKER veroeffentlichen" -ForegroundColor White
Write-Host "  ========================"

# --- Version und Ziel ------------------------------------------------------

$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"

$fern = (git remote get-url origin) -replace '\.git$', ''
if ($fern -notmatch 'github\.com[:/]([^/]+)/(.+)$') {
  Schlecht "Die Adresse von origin sieht nicht nach GitHub aus: $fern"
  exit 1
}
$besitzer = $Matches[1]
$repo = $Matches[2]

Write-Host "  Version:    $version"
Write-Host "  Ziel:       $besitzer/$repo"

# --- 1. EXE bauen, wenn noetig ---------------------------------------------

$exe = 'dist\Tracker.exe'
$neuste = Get-ChildItem 'src', 'tools', 'build.mjs', 'build-exe.mjs' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.js', '.mjs', '.html', '.css', '.txt', '.png' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ((-not (Test-Path $exe)) -or ($neuste -and (Get-Item $exe).LastWriteTime -lt $neuste.LastWriteTime)) {
  Schritt "Die EXE ist aelter als der Quellcode — wird neu gebaut. Das dauert ein bis zwei Minuten."
  node build.mjs | Out-Null
  node build-exe.mjs | Out-Null
  if (-not (Test-Path $exe)) { Schlecht "Der Bau ist fehlgeschlagen."; exit 1 }
  Gut "EXE gebaut."
} else {
  Gut "EXE ist aktuell."
}
$exeInfo = Get-Item $exe
Write-Host "              $([math]::Round($exeInfo.Length/1MB,1)) MB"

# --- 2. Commits hochschieben ------------------------------------------------

$offen = git status --porcelain
if ($offen) {
  Schlecht "Es liegen ungespeicherte Aenderungen vor:"
  git status --short
  Write-Host "`n  Erst committen, dann veroeffentlichen. Abgebrochen." -ForegroundColor Yellow
  exit 1
}

$zweig = git rev-parse --abbrev-ref HEAD
Schritt "Commits hochschieben ($zweig) ..."
# Ohne Umleitung und ohne Abbruch bei Ausgabe: Git schreibt seinen Fortschritt
# auf den Fehlerkanal, und PowerShell machte daraus sonst einen Abbruch,
# obwohl der Push gelungen ist. Massgeblich ist allein der Rueckgabewert.
$ErrorActionPreference = 'Continue'
git push origin $zweig | Out-Null
$erfolg = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $erfolg) {
  Schlecht "Der Push ist fehlgeschlagen. Bitte einmal von Hand 'git push' ausfuehren."
  exit 1
}
Gut "Stand ist oben."

# --- 3. Zugangsdaten holen --------------------------------------------------

Schritt "Anmeldung bei GitHub ..."
# Ueber eine Datei statt ueber die Pipe: "git credential fill" erwartet die
# Anfrage mit reinen Zeilenumbruechen und einer Leerzeile am Ende. Was
# PowerShell durch eine Pipe schickt, weist es mit "missing protocol field" ab.
$tmp = [System.IO.Path]::GetTempFileName()
$token = $null
try {
  [System.IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n", (New-Object System.Text.ASCIIEncoding))
  $ErrorActionPreference = 'Continue'
  $antwort = cmd /c "git credential fill < `"$tmp`""
  $ErrorActionPreference = 'Stop'
  $treffer = $antwort | Select-String '^password=(.+)$'
  if ($treffer) { $token = $treffer.Matches[0].Groups[1].Value }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
if (-not $token) {
  Schlecht "Keine GitHub-Zugangsdaten gefunden."
  Write-Host "  Einmal 'git push' von Hand ausfuehren und anmelden, dann klappt es." -ForegroundColor Yellow
  exit 1
}
Gut "Angemeldet."

$kopf = @{
  Authorization = "Bearer $token"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'tracker-release'
}

# --- 4. Release anlegen -----------------------------------------------------

$notizen = "docs\release-notes-$version.md"
# Ausdruecklich als UTF-8 lesen: sonst kommen die Umlaute aus der Notizdatei
# als Fragezeichen bei GitHub an.
$text = if (Test-Path $notizen) {
  [System.IO.File]::ReadAllText((Resolve-Path $notizen), [System.Text.Encoding]::UTF8)
} else { "TRACKER $version" }

Schritt "Release $tag anlegen ..."
$basis = "https://api.github.com/repos/$besitzer/$repo"

# Gibt es das Release schon? Dann nicht doppelt anlegen, sondern weiterbenutzen.
$release = $null
try {
  $release = Invoke-RestMethod -Uri "$basis/releases/tags/$tag" -Headers $kopf -TimeoutSec 60
  Gut "Release $tag gibt es schon — die Datei wird ersetzt."
} catch {
  $rumpf = @{ tag_name = $tag; name = "TRACKER $version"; body = $text; draft = $false; prerelease = $false } | ConvertTo-Json
  # Als UTF-8-Bytes senden, nicht als Zeichenkette: PowerShell 5.1 kodiert
  # einen Zeichenketten-Rumpf sonst latin-1, und GitHub weist das ab.
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($rumpf)
  try {
    $release = Invoke-RestMethod -Uri "$basis/releases" -Method Post -Headers $kopf -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
    Gut "Release angelegt."
  } catch {
    Schlecht "Das Release liess sich nicht anlegen: $($_.Exception.Message)"
    # Die Antwort von GitHub sagt meist genau, was fehlt — sie gehoert
    # hierher, statt den Nutzer raten zu lassen.
    if ($_.Exception.Response) {
      $leser = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      Write-Host "  $($leser.ReadToEnd())" -ForegroundColor Yellow
      $leser.Close()
    }
    exit 1
  }
}

# --- 5. EXE anhaengen -------------------------------------------------------

# Eine gleichnamige Datei zuerst wegnehmen: GitHub weist ein Duplikat sonst ab.
foreach ($a in $release.assets) {
  if ($a.name -eq 'Tracker.exe') {
    Invoke-RestMethod -Uri "$basis/releases/assets/$($a.id)" -Method Delete -Headers $kopf -TimeoutSec 60 | Out-Null
  }
}

Schritt "EXE hochladen ($([math]::Round($exeInfo.Length/1MB,1)) MB) — das dauert je nach Leitung ein paar Minuten ..."
$ziel = ($release.upload_url -replace '\{\?name,label\}', '') + '?name=Tracker.exe'
try {
  $hoch = Invoke-RestMethod -Uri $ziel -Method Post -Headers $kopf -ContentType 'application/octet-stream' -InFile $exeInfo.FullName -TimeoutSec 3600
  Gut "Hochgeladen: $($hoch.name), $([math]::Round($hoch.size/1MB,1)) MB"
} catch {
  Schlecht "Das Hochladen ist fehlgeschlagen: $($_.Exception.Message)"
  Write-Host "  Das Release steht bereits — die Datei laesst sich dort von Hand nachreichen:" -ForegroundColor Yellow
  Write-Host "  $($release.html_url)"
  exit 1
}

# --- Fertig -----------------------------------------------------------------

Write-Host ""
Write-Host "  Fertig." -ForegroundColor Green
Write-Host "  $($release.html_url)"
Write-Host ""
