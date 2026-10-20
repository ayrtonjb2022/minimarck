# Custom NSIS installer script for MiniMarck.
#
# WHY THIS FILE EXISTS
# --------------------
# electron-builder normally builds the uninstaller by running a throwaway NSIS stub at build
# time (`NsisTarget.computeScriptAndSignUninstaller` -> `BUILD_UNINSTALLER` ->
# `WineVmManager.exec(installerPath)`) and harvesting the `Uninstall.exe` it writes. On this
# machine that stub dies on a modal "NSIS Error: Error writing temporary file." dialog, so the
# build hangs until the 120 s Wine timeout kills it and reports `Exit code: null`. The final
# installer is never produced.
#
# Setting `nsis.script` makes electron-builder return early (NsisTarget.js: `if (customScriptPath
# != null) return { script, isCustomScript: true }`) and skip the harvest entirely. That means
# nothing writes `Uninstall MiniMarck.exe` at build time, so this script writes it at install time
# with `WriteUninstaller` instead. NSIS handles that natively and it needs no elevation.
#
# Everything else -- payload extraction, shortcuts, registry layout, per-user semantics -- is
# kept identical to electron-builder's own templates so the installed result is unchanged.

!include "MUI2.nsh"
# x64.nsh provides ${RunningX64}/${IsNativeARM64}/${IsNativeAMD64}, which
# `extractAppPackage.nsh` uses to pick the embedded payload. electron-builder's own templates get
# this transitively through common.nsh; this script has no common.nsh, so it includes it directly.
# All three ship with NSIS, so neither include needs a path.
!include "x64.nsh"

# Provided by electron-builder's shared installer header (computeCommonInstallerScriptHeader):
# `!include StdUtils.nsh`, `!addincludedir .../templates/nsis/include`, the plugin dirs, the
# messages.yml strings and the `addLangs` macro. It is inserted BELOW, after the page macros: MUI2
# builds its per-page function registry in `MUI_PAGE_INIT`, and electron-builder passes `-WX`, so
# a page declared after the language insertion leaves `mui.FinishPage.GUIInit` unreferenced and the
# build dies on a warning.

!define APP_EXE_FILENAME "${APP_FILENAME}.exe"
!define UNINSTALL_EXE_FILENAME "Uninstall ${APP_FILENAME}.exe"

!define REG_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!define REG_INSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Install\${UNINSTALL_APP_KEY}"

!ifdef allowToChangeInstallationDirectory
  !ifndef INSTALL_DIRECTORY
    !define INSTALL_DIRECTORY "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  !endif
!else
  !define INSTALL_DIRECTORY "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
!endif

Name "${PRODUCT_NAME} ${VERSION}"
BrandingText "${PRODUCT_NAME} ${VERSION}"

# Per-user install: never elevate.
RequestExecutionLevel user

ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
# electron-builder is invoked with `-WX` (warnings are errors), and MUI2 leaves
# `mui.FinishPage.GUIInit` unreferenced unless the finish page has something to initialise.
# `runAfterFinish: true` in electron-builder.yml is the product decision; this is its
# implementation, and it is also what keeps the build warning-clean.
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE_FILENAME}"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!include "extractAppPackage.nsh"

!insertmacro addLangs

Function .onInit
  # x64-only build (see the `arch` list in electron-builder.yml), so the 64-bit registry view is
  # correct unconditionally. Written without an ${If} wrapper on purpose: electron-builder's
  # templates use its own lowercase `${if}`, and NSIS's stock `${If}` needs jump targets, so
  # importing LogicLib here would be the wrong macro family.
  SetRegView 64

  # Per-user: resolve CSIDL against the current user only.
  SetShellVarContext current

  InitPluginsDir
  SetOverwrite on

  StrCpy $INSTDIR "${INSTALL_DIRECTORY}"
  SetOutPath $INSTDIR
FunctionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "install" InstallSection
  SectionSetSize 0 ${ESTIMATED_SIZE}

  SetShellVarContext current
  SetOutPath $INSTDIR

  # Embeds the 100 MB payload at compile time and extracts it into $INSTDIR with Nsis7z.
  !insertmacro extractEmbeddedAppPackage

  # electron-builder normally ships a build-time harvested uninstaller; this script is the
  # replacement, written at install time.
  WriteUninstaller "$INSTDIR\${UNINSTALL_EXE_FILENAME}"

  # Registry: mirrors electron-builder's `registryAddInstallInfo` for current-user installs.
  WriteRegStr HKCU "${REG_INSTALL_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${REG_INSTALL_KEY}" KeepShortcuts "true"
  WriteRegStr HKCU "${REG_INSTALL_KEY}" ShortcutName "${SHORTCUT_NAME}"

  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" DisplayName "${UNINSTALL_DISPLAY_NAME}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" UninstallString '"$INSTDIR\${UNINSTALL_EXE_FILENAME}" /currentuser'
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALL_EXE_FILENAME}" /currentuser /S'
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" DisplayVersion "${VERSION}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" DisplayIcon "$INSTDIR\${APP_EXE_FILENAME},0"
  !ifdef COMPANY_NAME
    WriteRegStr HKCU "${REG_UNINSTALL_KEY}" Publisher "${COMPANY_NAME}"
  !endif
  !ifdef APP_DESCRIPTION
    WriteRegStr HKCU "${REG_UNINSTALL_KEY}" Comments "${APP_DESCRIPTION}"
  !endif

  # Shortcuts: Start Menu program folder + Desktop.
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXE_FILENAME}"
  !ifndef no-desktop-shortcut
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXE_FILENAME}"
  !endif
SectionEnd

Section "un.install" UninstallSection
  SetRegView 64
  SetShellVarContext current

  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${SHORTCUT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"

  DeleteRegKey HKCU "${REG_UNINSTALL_KEY}"
  DeleteRegKey HKCU "${REG_INSTALL_KEY}"

  RMDir /r "$INSTDIR"
SectionEnd