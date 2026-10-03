@echo off
REM Double-click this to open MiniMarck. The real launcher is desktop\scripts\abrir.mjs and its
REM reasoning lives there in full; this file only locates the desktop\ folder, so the directory you
REM happen to be in never matters. Running `npm run launch` from the repository root is the usual
REM way to get "Missing script: launch" and nothing else, because the package.json is in desktop\.
REM
REM `cd /d` handles a repository on another drive; `%~dp0` is this file's own directory.
setlocal
cd /d "%~dp0desktop"
call npm run abrir
if errorlevel 1 pause
endlocal
