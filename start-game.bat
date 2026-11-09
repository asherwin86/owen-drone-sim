@echo off
cd /d "%~dp0"

if not exist node_modules\cesium (
  echo First run: installing game files, this takes a minute...
  call npm install
)

if not exist node_modules\electron\dist\electron.exe (
  echo Setting up the game window...
  call node node_modules\electron\install.js
)

if exist node_modules\electron\dist\electron.exe (
  call npm start
) else (
  echo.
  echo Could not download the game window right now.
  echo Opening the game in your web browser instead...
  start "" http://127.0.0.1:47831/
  node server.js
)
