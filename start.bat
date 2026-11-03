@echo off
REM ============================================================
REM  Talaria - arranque local
REM  Solo necesita Node.js. Sin npm install: no hay dependencias.
REM  yt-dlp, FFmpeg y aria2c se instalan solos la primera vez.
REM ============================================================
setlocal
title Talaria
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Talaria necesita Node.js 20 o superior.
    echo   Instalalo con:  winget install OpenJS.NodeJS.LTS
    echo   o desde https://nodejs.org y vuelve a abrir este archivo.
    echo.
    pause
    goto :eof
)

node server\index.mjs --abrir

echo.
echo   Talaria se detuvo.
pause
