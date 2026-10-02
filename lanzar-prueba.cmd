@echo off
REM Lanzar MiniMarck escritorio para probarlo a mano.
REM Usa el codigo del repo (no el instalador) y el perfil real del usuario.
cd /d "%~dp0"
if not exist "desktop\node_modules" (
  echo Faltan las dependencias. Ejecuta: cd desktop ^&^& npm install
  pause
  exit /b 1
)
cd desktop
call npm run launch