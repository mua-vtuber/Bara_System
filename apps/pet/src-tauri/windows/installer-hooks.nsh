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

; ---------------------------------------------------------------------------------------------------------------
; Optional removal of the search models Bara downloaded (uninstaller only, unchecked by default).
;
; Where this runs: Tauri's template (tauri-cli 2.11.4) `!include`s this file near the top of installer.nsi, after
; MUI2/utils and before its own `Var` declarations and page macros. The `UninstPage custom` below therefore becomes
; the FIRST uninstaller page, shown before Tauri's confirm page (which keeps its own "delete app data" checkbox for
; $APPDATA/$LOCALAPPDATA\app.bara.pet, a different folder). Because Tauri's variables ($PassiveMode, $UpdateMode)
; are declared after this point, the page functions read the command line themselves; the deletion itself runs from
; NSIS_HOOK_POSTUNINSTALL, a macro expanded inside Tauri's `Section Uninstall`, where those variables exist.
; If a future template moved the include below its pages, this page would land after the uninstall step and its
; state would still be unset when the deletion check runs, so nothing would be deleted (safe failure).
;
; When the option is never offered (state stays 0, nothing is deleted):
; - /S silent runs: NSIS shows no pages at all.
; - /P passive runs: Tauri adds /P when its installer runs the old uninstaller from a passive install.
; - /UPDATE runs.
; - The uninstaller started directly with `_?=<install dir>`: that is how Tauri's installer runs the old uninstaller
;   for "uninstall before installing" (manual update, reinstall). The normal uninstall path (Settings > Apps) starts
;   uninstall.exe without `_?=`, and NSIS then copies the uninstaller to %TEMP% and runs that copy, so $EXEDIR is
;   the temp folder there and the install folder only in the installer-driven case (NSIS docs, uninstaller `_?=`).
;
; The data root is resolved like the pet host (src-tauri/src/bridge.rs default_data_dir): BARA_PET_DATA_DIR when
; set, otherwise %LOCALAPPDATA%\Bara\Pet. Only the two model folders of the local memory server are removed
; (apps/pet/src/service/install/disk-space.ts MODEL_DIRS, apps/setup/src/paths.ts); the memory DB, settings,
; secrets and backups under <root>\memory are never touched.
; ---------------------------------------------------------------------------------------------------------------

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

!define BARA_DATA_DIR_ENV "BARA_PET_DATA_DIR"
!define BARA_LOCALAPPDATA_ENV "LOCALAPPDATA"
!define BARA_DEFAULT_DATA_SUBDIR "Bara\Pet"
!define BARA_MEMORY_DIR "memory"
!define BARA_MODELS_PARENT "${BARA_MEMORY_DIR}\models"
!define BARA_MODEL_DIR_HF "hf-cache"
!define BARA_MODEL_DIR_KIWI "kiwi-model"
; The memory server runs with this Bun (apps/pet/src/service/install/runtime.ts); Tauri's uninstall section already
; tried to delete it, so if it is still here a process from this install is still holding it.
!define BARA_SERVICE_RUNTIME "resources\runtime\bun.exe"
!define BARA_RUNTIME_WAIT_TRIES 20
!define BARA_RUNTIME_WAIT_MS 500
!define BARA_FILE_ATTRIBUTE_REPARSE_POINT 0x400
!define BARA_INVALID_FILE_ATTRIBUTES -1
; MUI header text controls on the outer window (MUI2 Interface: GetDlgItem $HWNDPARENT 1037 / 1038).
!define BARA_MUI_HEADER_TEXT_ID 1037
!define BARA_MUI_HEADER_SUBTEXT_ID 1038

; User-facing text. The installer is built with Korean only (tauri.conf.json bundle.windows.nsis.languages), and
; LangString cannot be used here because the language is loaded after this file. Keep "1.7GB" in step with
; LOCAL_INSTALL_MODEL_BYTES in src/shared/contracts.ts.
!define BARA_TEXT_PAGE_TITLE "제거 선택 사항"
!define BARA_TEXT_PAGE_SUBTITLE "바라가 내려받은 검색용 AI 모델을 함께 지울지 고릅니다."
!define BARA_TEXT_PAGE_BODY "바라는 이 PC에서 기억을 검색하려고 검색용 AI 모델(약 1.7GB)을 내려받아 둡니다. 아래 칸을 선택하면 그 모델 폴더 두 개(hf-cache, kiwi-model)만 함께 지웁니다.$\r$\n$\r$\n기억 DB, 설정, 로그인 정보, 백업은 지우지 않습니다. Ollama나 LM Studio의 모델도 건드리지 않습니다. 나중에 다시 설치하면 모델을 다시 내려받습니다."
!define BARA_TEXT_DELETE_MODELS "검색용 AI 모델도 삭제 (약 1.7GB, 기억 데이터는 남음)"
!define BARA_TEXT_DELETED "검색용 AI 모델 폴더를 지웠습니다: "
!define BARA_TEXT_NOT_PRESENT "검색용 AI 모델 폴더가 없어 건너뜁니다: "
!define BARA_TEXT_FAILED_HEAD "검색용 AI 모델을 지우지 못했습니다. 기억 데이터는 그대로입니다."
!define BARA_TEXT_FAILED_TAIL "필요하면 바라를 모두 끈 뒤 이 폴더를 직접 지우세요."
!define BARA_TEXT_ROOT_UNSET "데이터 폴더를 정할 수 없습니다. 환경 변수 LOCALAPPDATA 가 없습니다."
!define BARA_TEXT_ROOT_NOT_ABSOLUTE "데이터 폴더 경로가 절대 경로가 아닙니다 (환경 변수 BARA_PET_DATA_DIR): "
!define BARA_TEXT_ROOT_MISSING "데이터 폴더가 없어 지울 모델이 없습니다: "
!define BARA_TEXT_OUTSIDE_ROOT "모델 폴더가 데이터 폴더 밖을 가리켜 지우지 않았습니다: "
!define BARA_TEXT_REPARSE "모델 폴더 경로에 다른 곳으로 연결된 폴더(링크)가 있어 지우지 않았습니다: "
!define BARA_TEXT_RUNTIME_BUSY "바라 메모리 서버(bun.exe)가 아직 실행 중이라 모델 파일을 지울 수 없습니다: "
!define BARA_TEXT_STILL_THERE "폴더를 다 지우지 못했습니다. 다른 프로그램이 파일을 쓰고 있을 수 있습니다: "

Var BaraDeleteModelsCheckbox
Var BaraDeleteModelsState
Var BaraOption
Var BaraRoot
Var BaraModelsDir
Var BaraTarget
Var BaraFailed
Var BaraTries
Var BaraLength
Var BaraWork

UninstPage custom un.BaraModelsPageCreate un.BaraModelsPageLeave

Function un.BaraModelsPageCreate
  ; Skipped (Abort in a custom page's create function) whenever this run is not an interactive, user-started
  ; uninstall. See the header comment for why each case is an update or unattended run.
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $BaraOption
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $BaraOption
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${If} $EXEDIR == $INSTDIR
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $BaraWork
  ${If} $BaraWork == error
    Abort
  ${EndIf}

  GetDlgItem $BaraWork $HWNDPARENT ${BARA_MUI_HEADER_TEXT_ID}
  SendMessage $BaraWork ${WM_SETTEXT} 0 "STR:${BARA_TEXT_PAGE_TITLE}"
  GetDlgItem $BaraWork $HWNDPARENT ${BARA_MUI_HEADER_SUBTEXT_ID}
  SendMessage $BaraWork ${WM_SETTEXT} 0 "STR:${BARA_TEXT_PAGE_SUBTITLE}"

  ${NSD_CreateLabel} 0 0 100% 64u "${BARA_TEXT_PAGE_BODY}"
  Pop $BaraWork
  ${NSD_CreateCheckbox} 0 76u 100% 12u "${BARA_TEXT_DELETE_MODELS}"
  Pop $BaraDeleteModelsCheckbox
  ; Unchecked by default; keeps the user's choice when they come back with the Back button.
  ${If} $BaraDeleteModelsState = ${BST_CHECKED}
    ${NSD_Check} $BaraDeleteModelsCheckbox
  ${Else}
    ${NSD_Uncheck} $BaraDeleteModelsCheckbox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.BaraModelsPageLeave
  ${NSD_GetState} $BaraDeleteModelsCheckbox $BaraDeleteModelsState
FunctionEnd

; Shows a failure in the uninstall log and in a dialog, and keeps the log window open, so a skipped or partial
; deletion is never silent. Input: the message on the stack.
Function un.BaraReportFailure
  Exch $BaraWork
  StrCpy $BaraFailed 1
  DetailPrint "$BaraWork"
  SetAutoClose false
  MessageBox MB_OK|MB_ICONEXCLAMATION "${BARA_TEXT_FAILED_HEAD}$\r$\n$\r$\n$BaraWork$\r$\n$\r$\n${BARA_TEXT_FAILED_TAIL}" /SD IDOK
  Pop $BaraWork
FunctionEnd

; Fails (report + $BaraFailed = 1) when $BaraTarget is a reparse point (junction or symbolic link), because
; following one could delete files outside the data folder.
Function un.BaraRefuseReparsePoint
  System::Call 'kernel32::GetFileAttributesW(w "$BaraTarget") i .s'
  Pop $BaraWork
  ${If} $BaraWork <> ${BARA_INVALID_FILE_ATTRIBUTES}
    IntOp $BaraWork $BaraWork & ${BARA_FILE_ATTRIBUTE_REPARSE_POINT}
    ${If} $BaraWork <> 0
      Push "${BARA_TEXT_REPARSE}$BaraTarget"
      Call un.BaraReportFailure
    ${EndIf}
  ${EndIf}
FunctionEnd

; Deletes $BaraModelsDir\<name> (name on the stack) after checking it stays inside $BaraRoot.
Function un.BaraDeleteModelDir
  Exch $BaraOption
  StrCpy $BaraTarget "$BaraModelsDir\$BaraOption"
  Pop $BaraOption

  ${IfNot} ${FileExists} "$BaraTarget\*.*"
    DetailPrint "${BARA_TEXT_NOT_PRESENT}$BaraTarget"
    Return
  ${EndIf}

  ClearErrors
  GetFullPathName $BaraWork "$BaraTarget"
  ${If} ${Errors}
  ${OrIf} $BaraWork == ""
    Push "${BARA_TEXT_OUTSIDE_ROOT}$BaraTarget"
    Call un.BaraReportFailure
    Return
  ${EndIf}
  StrCpy $BaraTarget $BaraWork
  StrLen $BaraLength "$BaraRoot\"
  StrCpy $BaraWork $BaraTarget $BaraLength
  ${If} $BaraWork != "$BaraRoot\"
    Push "${BARA_TEXT_OUTSIDE_ROOT}$BaraTarget"
    Call un.BaraReportFailure
    Return
  ${EndIf}

  StrCpy $BaraFailed 0
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}

  RMDir /r "$BaraTarget"
  ${If} ${FileExists} "$BaraTarget\*.*"
    Push "${BARA_TEXT_STILL_THERE}$BaraTarget"
    Call un.BaraReportFailure
  ${Else}
    DetailPrint "${BARA_TEXT_DELETED}$BaraTarget"
  ${EndIf}
FunctionEnd

Function un.BaraDeleteModels
  ; 1. Resolve the data root exactly as the pet host does. An environment variable that is set but empty is not
  ;    "unset" for the host (it would use a relative path), so it is refused here rather than replaced.
  ClearErrors
  ReadEnvStr $BaraRoot ${BARA_DATA_DIR_ENV}
  ${If} ${Errors}
    ClearErrors
    ReadEnvStr $BaraWork ${BARA_LOCALAPPDATA_ENV}
    ${If} ${Errors}
    ${OrIf} $BaraWork == ""
      Push "${BARA_TEXT_ROOT_UNSET}"
      Call un.BaraReportFailure
      Return
    ${EndIf}
    StrCpy $BaraRoot "$BaraWork\${BARA_DEFAULT_DATA_SUBDIR}"
  ${EndIf}

  ; 2. Absolute paths only: "X:\..." / "X:/..." or a UNC path ("\\server\share", "//server/share").
  StrCpy $BaraFailed 1
  StrCpy $BaraWork $BaraRoot 2
  ${If} $BaraWork == "\\"
  ${OrIf} $BaraWork == "//"
    StrCpy $BaraFailed 0
  ${EndIf}
  StrCpy $BaraWork $BaraRoot 2 1
  ${If} $BaraWork == ":\"
  ${OrIf} $BaraWork == ":/"
    StrCpy $BaraFailed 0
  ${EndIf}
  ${If} $BaraFailed = 1
    Push "${BARA_TEXT_ROOT_NOT_ABSOLUTE}$BaraRoot"
    Call un.BaraReportFailure
    Return
  ${EndIf}

  ; 3. Canonical root (resolves "." / ".." and slashes) so the containment check compares like with like.
  ${IfNot} ${FileExists} "$BaraRoot\*.*"
    DetailPrint "${BARA_TEXT_ROOT_MISSING}$BaraRoot"
    Return
  ${EndIf}
  ClearErrors
  GetFullPathName $BaraWork "$BaraRoot"
  ${If} ${Errors}
  ${OrIf} $BaraWork == ""
    Push "${BARA_TEXT_ROOT_NOT_ABSOLUTE}$BaraRoot"
    Call un.BaraReportFailure
    Return
  ${EndIf}
  StrCpy $BaraRoot $BaraWork
  StrCpy $BaraWork $BaraRoot 1 -1
  ${If} $BaraWork == "\"
    StrCpy $BaraRoot $BaraRoot -1
  ${EndIf}

  ; 4. The memory server must be gone. Tauri's section closed the pet (its Bun service sits in a kill-on-close Job
  ;    object, src-tauri/src/windows.rs attach_job) and then tried to delete this Bun; an executable that is still
  ;    running cannot be deleted, so retrying the delete tells whether that process has ended.
  StrCpy $BaraTries 0
  ${DoWhile} ${FileExists} "$INSTDIR\${BARA_SERVICE_RUNTIME}"
    Delete "$INSTDIR\${BARA_SERVICE_RUNTIME}"
    ${If} ${FileExists} "$INSTDIR\${BARA_SERVICE_RUNTIME}"
      IntOp $BaraTries $BaraTries + 1
      ${If} $BaraTries >= ${BARA_RUNTIME_WAIT_TRIES}
        Push "${BARA_TEXT_RUNTIME_BUSY}$INSTDIR\${BARA_SERVICE_RUNTIME}"
        Call un.BaraReportFailure
        Return
      ${EndIf}
      Sleep ${BARA_RUNTIME_WAIT_MS}
    ${EndIf}
  ${Loop}

  ; 5. Refuse links on the way down: <root>\memory and <root>\memory\models.
  StrCpy $BaraModelsDir "$BaraRoot\${BARA_MODELS_PARENT}"
  StrCpy $BaraFailed 0
  StrCpy $BaraTarget "$BaraRoot\${BARA_MEMORY_DIR}"
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  StrCpy $BaraTarget $BaraModelsDir
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}

  Push "${BARA_MODEL_DIR_HF}"
  Call un.BaraDeleteModelDir
  Push "${BARA_MODEL_DIR_KIWI}"
  Call un.BaraDeleteModelDir
FunctionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ; The page sets the state only in an interactive, user-started uninstall; the update, passive and silent
  ; conditions are checked again here with Tauri's own variables so no other path can delete the models.
  ${If} $BaraDeleteModelsState = ${BST_CHECKED}
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
    Call un.BaraDeleteModels
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------------------
; Clean reinstall for the pet's own update (docs/decisions/2026-10-14-pet-self-update-spec.md 6.3).
;
; The pet runs the downloaded installer as `<setup>.exe /P /R /BARA_CLEAN` (src-tauri/src/self_update.rs
; INSTALLER_ARGS). Tauri's template (tauri-cli 2.11.4) never removes the old version in a /P run: PageReinstall builds
; no page there, so its radio state reads 0 and the upgrade branch keeps the old files ("reinst_done"), and /UPDATE
; skips the removal outright. So this hook runs the old uninstaller itself, before any file is copied:
; NSIS_HOOK_PREINSTALL is expanded at the top of `Section Install`, where $PassiveMode and $UpdateMode are set.
;
; It runs only when all four hold: /BARA_CLEAN is given, the run is /P, it is not /UPDATE, and the previous install
; left its uninstaller (UninstallString) and its folder (the product key's default value) in the registry.
; The uninstaller runs as `"<UninstallString>" /P /UPDATE _?=<old folder>`:
; - /UPDATE keeps the shortcuts and the login autostart value and removes only the program files (template
;   `Section Uninstall`: those deletions check `$UpdateMode <> 1`; this file's NSIS_HOOK_PREUNINSTALL does too).
; - /P skips the confirm page with its "delete app data" box and this file's model-deletion page.
; - _?= runs it in place and makes ExecWait wait for it, the way the template's own reinstall path does.
; A non-zero exit code or the old main executable still in place stops the install with a dialog: the files are never
; copied over a half-removed version. The old memory server's Bun (BARA_SERVICE_RUNTIME) is waited for the same way
; as in un.BaraDeleteModels step 4: the old pet's quit ends it with its Job object, and an executable that still runs
; cannot be deleted, so the delete is retried up to BARA_RUNTIME_WAIT_TRIES times; if it stays, the install stops too. Some of the old version may already be gone, so the dialog says to run this
; installer again by hand. Starting the old pet before that deletes this installer file (spec 6.2-1 startup cleanup),
; so the dialog also says the pet's arrow button downloads it again.
; ---------------------------------------------------------------------------------------------------------------

!define BARA_CLEAN_SWITCH "/BARA_CLEAN"
!define BARA_TEXT_CLEAN_START "이전 버전을 먼저 지웁니다: "
!define BARA_TEXT_CLEAN_FAILED_HEAD "이전 버전을 지우지 못해 설치를 멈췄습니다."
!define BARA_TEXT_CLEAN_NOT_STARTED "이전 버전의 제거 프로그램을 실행하지 못했습니다: "
!define BARA_TEXT_CLEAN_EXIT_CODE "이전 버전의 제거 프로그램이 오류로 끝났습니다. 종료 코드: "
!define BARA_TEXT_CLEAN_LEFTOVER "이전 버전의 실행 파일이 남아 있습니다: "
!define BARA_TEXT_CLEAN_RUNTIME_BUSY "이전 버전의 메모리 서버(bun.exe)가 아직 실행 중이라 지우지 못했습니다: "
!define BARA_TEXT_CLEAN_PARTIAL "이전 버전 일부가 이미 지워졌을 수 있습니다. 기억과 설정은 지우지 않았습니다."
!define BARA_TEXT_CLEAN_RETRY "이전 버전의 펫을 먼저 켜면 이 설치 파일이 지워지며, 그때는 펫 오른쪽 아래 화살표 버튼으로 다시 받을 수 있습니다.$\r$\n설치 파일을 직접 다시 실행하세요: "

Var BaraCleanOption
Var BaraOldUninstaller
Var BaraOldDir
Var BaraCleanExit
Var BaraCleanMessage

!macro NSIS_HOOK_PREINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "${BARA_CLEAN_SWITCH}" $BaraCleanOption
  ${IfNot} ${Errors}
  ${AndIf} $PassiveMode = 1
  ${AndIf} $UpdateMode <> 1
    ReadRegStr $BaraOldUninstaller SHCTX "${UNINSTKEY}" "UninstallString"
    ReadRegStr $BaraOldDir SHCTX "${MANUPRODUCTKEY}" ""
    ${If} $BaraOldUninstaller != ""
    ${AndIf} $BaraOldDir != ""
      DetailPrint "${BARA_TEXT_CLEAN_START}$BaraOldDir"
      ClearErrors
      ExecWait '$BaraOldUninstaller /P /UPDATE _?=$BaraOldDir' $BaraCleanExit
      ${If} ${Errors}
        StrCpy $BaraCleanMessage "${BARA_TEXT_CLEAN_NOT_STARTED}$BaraOldUninstaller"
      ${ElseIf} $BaraCleanExit <> 0
        StrCpy $BaraCleanMessage "${BARA_TEXT_CLEAN_EXIT_CODE}$BaraCleanExit"
      ${ElseIf} ${FileExists} "$BaraOldDir\${MAINBINARYNAME}.exe"
        StrCpy $BaraCleanMessage "${BARA_TEXT_CLEAN_LEFTOVER}$BaraOldDir\${MAINBINARYNAME}.exe"
      ${Else}
        StrCpy $BaraCleanMessage ""
        StrCpy $BaraTries 0
        ${DoWhile} ${FileExists} "$BaraOldDir\${BARA_SERVICE_RUNTIME}"
          Delete "$BaraOldDir\${BARA_SERVICE_RUNTIME}"
          ${If} ${FileExists} "$BaraOldDir\${BARA_SERVICE_RUNTIME}"
            IntOp $BaraTries $BaraTries + 1
            ${If} $BaraTries >= ${BARA_RUNTIME_WAIT_TRIES}
              StrCpy $BaraCleanMessage "${BARA_TEXT_CLEAN_RUNTIME_BUSY}$BaraOldDir\${BARA_SERVICE_RUNTIME}"
              ${Break}
            ${EndIf}
            Sleep ${BARA_RUNTIME_WAIT_MS}
          ${EndIf}
        ${Loop}
      ${EndIf}
      ${If} $BaraCleanMessage != ""
        DetailPrint "$BaraCleanMessage"
        SetAutoClose false
        MessageBox MB_OK|MB_ICONSTOP "${BARA_TEXT_CLEAN_FAILED_HEAD}$\r$\n$\r$\n$BaraCleanMessage$\r$\n${BARA_TEXT_CLEAN_PARTIAL}$\r$\n$\r$\n${BARA_TEXT_CLEAN_RETRY}$EXEPATH" /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
