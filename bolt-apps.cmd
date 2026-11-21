@echo off
setlocal EnableExtensions
where node >nul 2>&1
if errorlevel 1 (
  echo bolt-apps: Node 18 or newer is needed and was not found. Install it from https://nodejs.org, then run this again. 1>&2
  exit /b 127
)
for /f "usebackq delims=" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set MAJOR=%%v
if not defined MAJOR set MAJOR=0
if %MAJOR% LSS 18 (
  for /f "usebackq delims=" %%v in (`node -v`) do set NODEVER=%%v
  echo bolt-apps: Node 18 or newer is needed; this is Node %NODEVER%. Install a newer one from https://nodejs.org, then run this again. 1>&2
  exit /b 127
)
node "%~dp0toolkit\bin\bolt-apps.mjs" %*
exit /b %ERRORLEVEL%
