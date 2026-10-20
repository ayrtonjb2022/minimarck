@echo off
REM ---------------------------------------------------------------------------
REM MiniMarck - working launcher.
REM
REM WHY THIS EXISTS INSTEAD OF THE PACKAGED EXE.
REM
REM desktop\release\win-unpacked\MiniMarck.exe opens a window and dies instantly
REM with STATUS_BREAKPOINT (0x80000003). The crash is inside Electron itself, not
REM in the app code:
REM
REM   electron::fuses::IsLoadBrowserProcessSpecificV8SnapshotEnabled
REM   v8::ScriptCompiler::CreateCodeCacheForFunction
REM   v8_inspector::V8EmbedderState::V8EmbedderState
REM
REM and with the fuse forced off Chromium reports the real reason in
REM win-unpacked\debug.log:
REM
REM   FATAL:gin\v8_initializer.cc:675] Error loading V8 startup snapshot file
REM
REM The app code is fine: the same build run from a plain directory with the
REM canonical Electron runtime starts normally and reaches GPU init. So this
REM launcher runs THAT combination - the real runtime from node_modules against
REM the real build output in out\. Same code, same database, same profile.
REM ---------------------------------------------------------------------------
cd /d "%~dp0desktop"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Missing dependencies. Run: cd desktop ^&^& npm install
  pause
  exit /b 1
)
if not exist "out\main\index.js" (
  echo Missing build output. Run: cd desktop ^&^& npm run build
  pause
  exit /b 1
)
REM The flags mirror scripts\probe-launch.mjs. Without them the Chromium sandbox
REM kills the process with 0x80000003 on Windows.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0out" --no-sandbox --disable-gpu --disable-dev-shm-usage