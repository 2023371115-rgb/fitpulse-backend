# Prácticas 13 y 14 · MariaDB temporal para las pruebas en un runner self-hosted de Windows.
#
# En los runners de GitHub (Linux) la base se levanta como "service container"; en Windows
# eso no existe, así que este script:
#   1. descarga MariaDB portable (zip oficial) la primera vez y la guarda en la caché del runner;
#   2. crea una carpeta de datos nueva y vacía en RUNNER_TEMP (cada ejecución empieza limpia);
#   3. arranca mariadbd en el puerto indicado (3307 por defecto, para no chocar con un MySQL
#      que ya tenga la PC) con root sin contraseña, solo en 127.0.0.1;
#   4. espera a que acepte conexiones.
# El runner termina el proceso al acabar el job.
param([int]$Port = 3307, [string]$Version = '11.4.4')
$ErrorActionPreference = 'Continue'   # los ejecutables escriben avisos en stderr; se revisa $LASTEXITCODE
$ProgressPreference = 'SilentlyContinue'

$cache = if ($env:RUNNER_TOOL_CACHE) { $env:RUNNER_TOOL_CACHE } else { "$env:LOCALAPPDATA\fitpulse-ci" }
$home_ = Join-Path $cache "mariadb-$Version"
if (-not (Test-Path "$home_\bin\mariadbd.exe")) {
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $zip = Join-Path $env:TEMP "mariadb-$Version-winx64.zip"
  $url = "https://archive.mariadb.org/mariadb-$Version/winx64-packages/mariadb-$Version-winx64.zip"
  Write-Host "Descargando $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -ErrorAction Stop
  Expand-Archive -Path $zip -DestinationPath $cache -Force -ErrorAction Stop
  Rename-Item -Path (Join-Path $cache "mariadb-$Version-winx64") -NewName "mariadb-$Version"
}

$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$data = Join-Path $tmp 'mariadb-data'
if (Test-Path $data) { Remove-Item -Recurse -Force $data }
& "$home_\bin\mariadb-install-db.exe" "--datadir=$data" "--port=$Port" --allow-remote-root-access | Out-Host
if ($LASTEXITCODE -ne 0) { throw "mariadb-install-db terminó con código $LASTEXITCODE" }

# Sin RUNNER_TRACKING_ID el runner no termina el proceso al acabar este paso (lo hacía:
# MariaDB respondía aquí y ya no existía en el paso siguiente). El workflow lo detiene al final.
$env:RUNNER_TRACKING_ID = ''
$db = Start-Process -PassThru -FilePath "$home_\bin\mariadbd.exe" -ArgumentList "--datadir=`"$data`"", "--port=$Port", '--bind-address=127.0.0.1', '--console' `
  -RedirectStandardError (Join-Path $tmp 'mariadb.err') -RedirectStandardOutput (Join-Path $tmp 'mariadb.out') -WindowStyle Hidden
$db.Id | Out-File -Encoding ascii (Join-Path $tmp 'mariadb.pid')

for ($i = 0; $i -lt 60; $i++) {
  & "$home_\bin\mariadb-admin.exe" --host=127.0.0.1 --port=$Port --user=root ping 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "MariaDB $Version lista en 127.0.0.1:$Port"; exit 0 }
  Start-Sleep -Seconds 1
}
Get-Content (Join-Path $tmp 'mariadb.err') -Tail 40 -ErrorAction SilentlyContinue
throw "MariaDB no respondió en 60 s"
