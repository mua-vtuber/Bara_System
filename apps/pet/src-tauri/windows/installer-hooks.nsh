!macro NSIS_HOOK_PREUNINSTALL
  ; Removes the login autostart ("BaraPet" under HKCU Run) on a real uninstall, but not when the uninstaller runs
  ; for an update. Tauri's NSIS template (tauri-cli 2.11.4) sets $UpdateMode in un.onInit from the /UPDATE switch
  ; and keeps its own Run entry the same way (`${If} $UpdateMode <> 1`). That template never actually runs the old
  ; uninstaller with /UPDATE (an /UPDATE install skips the uninstall step, and the default "uninstall before
  ; installing" of a manual update runs it without), so the app also puts the value back after an update
  ; (src/ui/autostart-restore.ts); this check only follows the template's own convention.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BaraPet"
  ${EndIf}
!macroend
