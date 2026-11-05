!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
  ; The bundled lp helper: copied to %USERPROFILE%\.logicpacks\helper\bin and put on the user PATH
  ; (no admin, no Node). See packages/helper/install/app-install-lp.ps1.
  ${If} ${FileExists} "$INSTDIR\resources\lp\install-lp.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\lp\install-lp.ps1"'
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; Take the lp helper folder off the user PATH again (lp.exe itself stays in the user's data folder).
  ${If} ${FileExists} "$INSTDIR\resources\lp\install-lp.ps1"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\lp\install-lp.ps1" -RemovePath'
    Pop $0
  ${EndIf}
!macroend
