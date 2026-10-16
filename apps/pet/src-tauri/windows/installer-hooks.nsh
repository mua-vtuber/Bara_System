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
; Data cleanup on uninstall (uninstaller only).
;
; Where this runs: Tauri's template (tauri-cli 2.11.4) `!include`s this file near the top of installer.nsi, after
; MUI2/utils and before its own `Var` declarations and page macros. The `UninstPage custom` below therefore becomes
; the FIRST uninstaller page, shown before Tauri's confirm page. Because Tauri's variables ($PassiveMode, $UpdateMode,
; $DeleteAppDataCheckboxState) are declared after this point, the page functions read the command line themselves;
; the deletions run from NSIS_HOOK_POSTUNINSTALL, a macro expanded inside Tauri's `Section Uninstall`, where those
; variables exist. If a future template moved the include below its pages, this page would land after the uninstall
; step and its state would still be unset when the deletion check runs, so the models would not be deleted (safe
; failure); a renamed $DeleteAppDataCheckboxState stops the build instead.
;
; Three cleanups, all inside the pet's data root and none of them in an update or installer-driven run:
; - Always: the WebView2 data folder (src-tauri/src/main.rs, "webview") and the self-update downloads
;   (src/shared/native-host.json selfUpdate.updatesDirName). Both are rebuilt by the pet when needed.
; - The search models (this file's page, unchecked by default): only <root>\memory\models\hf-cache and \kiwi-model
;   (apps/pet/src/service/install/disk-space.ts MODEL_DIRS, apps/setup/src/paths.ts).
; - Everything (Tauri's confirm-page box "$(deleteAppData)"): the whole data root, memories included, after a
;   second Yes/No question whose default is No. The template's own deletion of that box only reaches
;   $APPDATA/$LOCALAPPDATA\app.bara.pet, which the pet never uses, so this hook gives the box its real meaning.
;
; When none of this runs:
; - /UPDATE runs.
; - The uninstaller started directly with `_?=<install dir>`: that is how Tauri's installer runs the old uninstaller
;   for "uninstall before installing" (manual update, reinstall) and how NSIS_HOOK_PREINSTALL below runs it for the
;   pet's own update. A downloaded installer may then be running from <root>\updates. The normal uninstall path
;   (Settings > Apps) starts uninstall.exe without `_?=`, and NSIS then copies the uninstaller to %TEMP% and runs that
;   copy, so $EXEDIR is the temp folder there and the install folder only in the installer-driven case (NSIS docs,
;   uninstaller `_?=`).
; - The page (models) and the confirm box (everything) are also never offered in /S silent or /P passive runs.
;
; The data root is resolved like the pet host (src-tauri/src/bridge.rs default_data_dir): BARA_PET_DATA_DIR when
; set, otherwise %LOCALAPPDATA%\Bara\Pet.
;
; Deletion never follows links: NSIS 3.11 `RMDir /r` walks into a junction and deletes the files it points to
; (checked by hand), so every tree goes through un.BaraRemoveTree, which removes a junction or symbolic link itself
; and leaves its target alone.
; ---------------------------------------------------------------------------------------------------------------

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

!define BARA_DATA_DIR_ENV "BARA_PET_DATA_DIR"
!define BARA_LOCALAPPDATA_ENV "LOCALAPPDATA"
!define BARA_DEFAULT_DATA_PARENT "Bara"
!define BARA_DEFAULT_DATA_SUBDIR "${BARA_DEFAULT_DATA_PARENT}\Pet"
!define BARA_MEMORY_DIR "memory"
!define BARA_MODELS_PARENT "${BARA_MEMORY_DIR}\models"
!define BARA_MODEL_DIR_HF "hf-cache"
!define BARA_MODEL_DIR_KIWI "kiwi-model"
!define BARA_WEBVIEW_DIR "webview"
!define BARA_UPDATES_DIR "updates"
; The memory server runs with this Bun (apps/pet/src/service/install/runtime.ts); Tauri's uninstall section already
; tried to delete it, so if it is still here a process from this install is still holding it.
!define BARA_SERVICE_RUNTIME "resources\runtime\bun.exe"
!define BARA_RUNTIME_WAIT_TRIES 20
!define BARA_RUNTIME_WAIT_MS 500
; WebView2 helper processes can hold their cache files for a moment after the pet has closed.
!define BARA_REMOVE_WAIT_TRIES 10
!define BARA_REMOVE_WAIT_MS 500
!define BARA_FILE_ATTRIBUTE_DIRECTORY 0x10
!define BARA_FILE_ATTRIBUTE_REPARSE_POINT 0x400
!define BARA_INVALID_FILE_ATTRIBUTES -1
; MUI header text controls on the outer window (MUI2 Interface: GetDlgItem $HWNDPARENT 1037 / 1038).
!define BARA_MUI_HEADER_TEXT_ID 1037
!define BARA_MUI_HEADER_SUBTEXT_ID 1038

; User-facing text. The installer is built with Korean only (tauri.conf.json bundle.windows.nsis.languages), and
; LangString cannot be used here because the language is loaded after this file. Keep "1.7GB" in step with
; LOCAL_INSTALL_MODEL_BYTES in src/shared/contracts.ts, and the box name in step with Tauri's Korean deleteAppData.
!define BARA_TEXT_PAGE_TITLE "제거 선택 사항"
!define BARA_TEXT_PAGE_SUBTITLE "바라가 내려받은 검색용 AI 모델을 함께 지울지 고릅니다."
!define BARA_TEXT_PAGE_BODY "바라는 이 PC에서 기억을 검색하려고 검색용 AI 모델(약 1.7GB)을 내려받아 둡니다. 아래 칸을 선택하면 그 모델 폴더 두 개(hf-cache, kiwi-model)만 함께 지웁니다. 기억 DB, 설정, 로그인 정보, 백업은 지우지 않고, Ollama나 LM Studio의 모델도 건드리지 않습니다.$\r$\n$\r$\n화면 캐시와 내려받아 둔 업데이트 파일은 항상 지웁니다. 기억까지 모두 지우려면 다음 화면의 '애플리케이션 데이터 삭제하기'를 선택하세요. 지우기 전에 한 번 더 묻습니다."
!define BARA_TEXT_DELETE_MODELS "검색용 AI 모델도 삭제 (약 1.7GB, 기억 데이터는 남음)"
!define BARA_TEXT_DELETED "폴더를 지웠습니다: "
!define BARA_TEXT_NOT_PRESENT "폴더가 없어 건너뜁니다: "
!define BARA_TEXT_MODELS_FAILED_HEAD "검색용 AI 모델을 지우지 못했습니다. 기억 데이터는 그대로입니다."
!define BARA_TEXT_CACHE_FAILED_HEAD "바라의 화면 캐시나 업데이트 파일을 다 지우지 못했습니다. 기억 데이터는 그대로입니다."
!define BARA_TEXT_ALL_FAILED_HEAD "바라 데이터 폴더를 다 지우지 못했습니다. 일부 데이터가 남아 있습니다."
!define BARA_TEXT_FAILED_TAIL "필요하면 바라를 모두 끈 뒤 이 폴더를 직접 지우세요."
!define BARA_TEXT_ROOT_UNSET "데이터 폴더를 정할 수 없습니다. 환경 변수 LOCALAPPDATA 가 없습니다."
!define BARA_TEXT_ROOT_NOT_ABSOLUTE "데이터 폴더 경로가 절대 경로가 아닙니다 (환경 변수 BARA_PET_DATA_DIR): "
!define BARA_TEXT_ROOT_MISSING "데이터 폴더가 없어 지울 것이 없습니다: "
!define BARA_TEXT_OUTSIDE_ROOT "지울 폴더가 데이터 폴더 밖을 가리켜 지우지 않았습니다: "
!define BARA_TEXT_REPARSE "지울 폴더 경로에 다른 곳으로 연결된 폴더(링크)가 있어 지우지 않았습니다: "
!define BARA_TEXT_RUNTIME_BUSY "바라 메모리 서버(bun.exe)가 아직 실행 중이라 데이터 파일을 지울 수 없습니다: "
!define BARA_TEXT_STILL_THERE "폴더를 다 지우지 못했습니다. 다른 프로그램이 파일을 쓰고 있을 수 있습니다: "
!define BARA_TEXT_ALL_UNSAFE_ROOT "데이터 폴더가 드라이브 전체나 Windows 기본 폴더를 품고 있어 통째로 지우지 않았습니다. 화면 캐시와 업데이트 파일만 지웁니다: "
!define BARA_TEXT_ALL_CONFIRM "'애플리케이션 데이터 삭제하기'를 선택했습니다. 바라 데이터 폴더 전체를 지웁니다:"
!define BARA_TEXT_ALL_CONFIRM_DETAIL "기억 DB, 첨부, 설정, 로그인 정보, AI 키, 서버 백업, 검색용 AI 모델이 모두 사라지며 되돌릴 수 없습니다. 문서 폴더의 'Bara 백업'은 지우지 않습니다.$\r$\n$\r$\n정말 모두 지울까요? '아니요'를 누르면 기억 데이터는 남기고 화면 캐시와 업데이트 파일만 지웁니다."
!define BARA_TEXT_ALL_KEPT "기억 데이터를 남겼습니다: "

Var BaraDeleteModelsCheckbox
Var BaraDeleteModelsState
Var BaraOption
Var BaraRoot
Var BaraRootIsDefault
Var BaraParent
Var BaraTarget
Var BaraFailed
Var BaraFailHead
Var BaraAllDone
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

  ${NSD_CreateLabel} 0 0 100% 84u "${BARA_TEXT_PAGE_BODY}"
  Pop $BaraWork
  ${NSD_CreateCheckbox} 0 96u 100% 12u "${BARA_TEXT_DELETE_MODELS}"
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

; Shows a failure under the heading in $BaraFailHead, in the uninstall log and in a dialog, and keeps the log window
; open, so a skipped or partial deletion is never silent. Input: the message on the stack.
Function un.BaraReportFailure
  Exch $BaraWork
  StrCpy $BaraFailed 1
  DetailPrint "$BaraWork"
  SetAutoClose false
  MessageBox MB_OK|MB_ICONEXCLAMATION "$BaraFailHead$\r$\n$\r$\n$BaraWork$\r$\n$\r$\n${BARA_TEXT_FAILED_TAIL}" /SD IDOK
  Pop $BaraWork
FunctionEnd

; Fails (report + $BaraFailed = 1) when $BaraTarget is a reparse point (junction or symbolic link), because
; deleting through one could reach files outside the data folder.
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

; Deletes the folder on the stack and everything in it without following links: a junction or symbolic link found
; inside is removed itself (RMDir / Delete on the link), never walked into. Files that stay locked are left; the
; caller checks what remains.
Function un.BaraRemoveTree
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  ClearErrors
  FindFirst $R1 $R2 "$R0\*"
  ${DoWhile} $R2 != ""
    ${If} $R2 != "."
    ${AndIf} $R2 != ".."
      System::Call 'kernel32::GetFileAttributesW(w "$R0\$R2") i .s'
      Pop $R3
      ${If} $R3 <> ${BARA_INVALID_FILE_ATTRIBUTES}
        IntOp $R4 $R3 & ${BARA_FILE_ATTRIBUTE_REPARSE_POINT}
        ${If} $R4 <> 0
          IntOp $R4 $R3 & ${BARA_FILE_ATTRIBUTE_DIRECTORY}
          ${If} $R4 <> 0
            RMDir "$R0\$R2"
          ${Else}
            Delete "$R0\$R2"
          ${EndIf}
        ${Else}
          IntOp $R4 $R3 & ${BARA_FILE_ATTRIBUTE_DIRECTORY}
          ${If} $R4 <> 0
            Push "$R0\$R2"
            Call un.BaraRemoveTree
          ${Else}
            SetFileAttributes "$R0\$R2" NORMAL
            Delete "$R0\$R2"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ClearErrors
    FindNext $R1 $R2
  ${Loop}
  FindClose $R1
  RMDir "$R0"
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; Deletes $BaraTarget (already checked by the caller), retrying while files are still held, and reports what stays.
Function un.BaraRemoveTarget
  StrCpy $BaraTries 0
  ${Do}
    Push "$BaraTarget"
    Call un.BaraRemoveTree
    ${IfNot} ${FileExists} "$BaraTarget\*.*"
      DetailPrint "${BARA_TEXT_DELETED}$BaraTarget"
      Return
    ${EndIf}
    IntOp $BaraTries $BaraTries + 1
    ${If} $BaraTries >= ${BARA_REMOVE_WAIT_TRIES}
      Push "${BARA_TEXT_STILL_THERE}$BaraTarget"
      Call un.BaraReportFailure
      Return
    ${EndIf}
    Sleep ${BARA_REMOVE_WAIT_MS}
  ${Loop}
FunctionEnd

; Deletes $BaraParent\<name> (name on the stack) after checking it stays inside $BaraRoot and is not a link.
Function un.BaraDeleteChild
  Exch $BaraOption
  StrCpy $BaraTarget "$BaraParent\$BaraOption"
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

  Call un.BaraRemoveTarget
FunctionEnd

; Resolves the data root exactly as the pet host does into $BaraRoot (canonical, no trailing backslash) and
; $BaraRootIsDefault. $BaraFailed = 1 means stop: a reported error, or (logged only) no data root to clean.
Function un.BaraResolveRoot
  ; 1. An environment variable that is set but empty is not "unset" for the host (it would use a relative path), so
  ;    it is refused here rather than replaced.
  StrCpy $BaraRootIsDefault 0
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
    StrCpy $BaraRootIsDefault 1
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

  ; 3. Canonical root (resolves "." / ".." and slashes) so the containment checks compare like with like.
  ${IfNot} ${FileExists} "$BaraRoot\*.*"
    DetailPrint "${BARA_TEXT_ROOT_MISSING}$BaraRoot"
    StrCpy $BaraFailed 1
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
FunctionEnd

; The memory server must be gone before its files are deleted. Tauri's section closed the pet (its Bun service sits
; in a kill-on-close Job object, src-tauri/src/windows.rs attach_job) and then tried to delete this Bun; an
; executable that is still running cannot be deleted, so retrying the delete tells whether that process has ended.
Function un.BaraWaitRuntime
  StrCpy $BaraFailed 0
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
FunctionEnd

; Sets $BaraFailed = 1 when the folder on the stack is $BaraRoot itself or lies inside it.
Function un.BaraRootHolds
  Exch $BaraWork
  StrCpy $BaraWork "$BaraWork\"
  StrLen $BaraLength "$BaraRoot\"
  StrCpy $BaraWork $BaraWork $BaraLength
  ${If} $BaraWork == "$BaraRoot\"
    StrCpy $BaraFailed 1
  ${EndIf}
  Pop $BaraWork
FunctionEnd

; $BaraFailed = 1 when deleting the whole $BaraRoot could take more than Bara's data: a drive or share root, or a
; folder holding the user profile, a Windows folder or the install folder. Only reachable through BARA_PET_DATA_DIR.
Function un.BaraCheckRootSafe
  StrCpy $BaraFailed 0
  ; "\\server\share" with nothing below it: no third backslash after the leading pair.
  StrCpy $BaraWork $BaraRoot 2
  ${If} $BaraWork == "\\"
    StrCpy $BaraTries 0
    StrCpy $BaraLength 2
    ${Do}
      StrCpy $BaraWork $BaraRoot 1 $BaraLength
      ${If} $BaraWork == ""
        ${ExitDo}
      ${EndIf}
      ${If} $BaraWork == "\"
        IntOp $BaraTries $BaraTries + 1
      ${EndIf}
      IntOp $BaraLength $BaraLength + 1
    ${Loop}
    ${If} $BaraTries < 2
      StrCpy $BaraFailed 1
    ${EndIf}
  ${EndIf}
  SetShellVarContext current
  ${ForEach} $BaraOption 0 10 + 1
    ${Select} $BaraOption
      ${Case} 0
        Push $PROFILE
      ${Case} 1
        Push $DESKTOP
      ${Case} 2
        Push $DOCUMENTS
      ${Case} 3
        Push $APPDATA
      ${Case} 4
        Push $LOCALAPPDATA
      ${Case} 5
        Push $TEMP
      ${Case} 6
        Push $WINDIR
      ${Case} 7
        Push $SYSDIR
      ${Case} 8
        Push $PROGRAMFILES
      ${Case} 9
        Push $PROGRAMFILES64
      ${CaseElse}
        Push $INSTDIR
    ${EndSelect}
    Call un.BaraRootHolds
  ${Next}
FunctionEnd

Function un.BaraDeleteModels
  StrCpy $BaraFailHead "${BARA_TEXT_MODELS_FAILED_HEAD}"
  Call un.BaraResolveRoot
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  Call un.BaraWaitRuntime
  ${If} $BaraFailed = 1
    Return
  ${EndIf}

  ; Refuse links on the way down: <root>\memory and <root>\memory\models.
  StrCpy $BaraParent "$BaraRoot\${BARA_MODELS_PARENT}"
  StrCpy $BaraTarget "$BaraRoot\${BARA_MEMORY_DIR}"
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  StrCpy $BaraTarget $BaraParent
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}

  Push "${BARA_MODEL_DIR_HF}"
  Call un.BaraDeleteChild
  Push "${BARA_MODEL_DIR_KIWI}"
  Call un.BaraDeleteChild
FunctionEnd

Function un.BaraDeleteCaches
  StrCpy $BaraFailHead "${BARA_TEXT_CACHE_FAILED_HEAD}"
  Call un.BaraResolveRoot
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  StrCpy $BaraParent $BaraRoot
  Push "${BARA_WEBVIEW_DIR}"
  Call un.BaraDeleteChild
  Push "${BARA_UPDATES_DIR}"
  Call un.BaraDeleteChild
FunctionEnd

; Deletes the whole data root after a second question. $BaraAllDone = 1 once deletion was attempted; it stays 0
; when the user answers No or the root is unsafe, so the caller runs the normal cleanup instead.
Function un.BaraDeleteAll
  StrCpy $BaraAllDone 0
  StrCpy $BaraFailHead "${BARA_TEXT_ALL_FAILED_HEAD}"
  Call un.BaraResolveRoot
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  Call un.BaraCheckRootSafe
  ${If} $BaraFailed = 1
    Push "${BARA_TEXT_ALL_UNSAFE_ROOT}$BaraRoot"
    Call un.BaraReportFailure
    Return
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${BARA_TEXT_ALL_CONFIRM}$\r$\n$BaraRoot$\r$\n$\r$\n${BARA_TEXT_ALL_CONFIRM_DETAIL}" /SD IDNO IDYES bara_delete_all_confirmed
  DetailPrint "${BARA_TEXT_ALL_KEPT}$BaraRoot"
  Return
  bara_delete_all_confirmed:

  StrCpy $BaraAllDone 1
  Call un.BaraWaitRuntime
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  StrCpy $BaraTarget $BaraRoot
  Call un.BaraRefuseReparsePoint
  ${If} $BaraFailed = 1
    Return
  ${EndIf}
  Call un.BaraRemoveTarget
  ; The default root's parent (%LOCALAPPDATA%\Bara) goes too when nothing else is in it; RMDir without /r leaves a
  ; folder that still holds anything.
  ${If} $BaraRootIsDefault = 1
  ${AndIfNot} ${FileExists} "$BaraRoot\*.*"
    ReadEnvStr $BaraWork ${BARA_LOCALAPPDATA_ENV}
    RMDir "$BaraWork\${BARA_DEFAULT_DATA_PARENT}"
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ; Update and installer-driven runs keep every data file (header comment). The confirm box and the models page are
  ; only ever set in an interactive, user-started uninstall; passive and silent are checked again with Tauri's own
  ; variables so no other path can delete memories or models.
  ${If} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    StrCpy $BaraAllDone 0
    ${If} $DeleteAppDataCheckboxState = ${BST_CHECKED}
    ${AndIf} $PassiveMode <> 1
    ${AndIfNot} ${Silent}
      Call un.BaraDeleteAll
    ${EndIf}
    ${If} $BaraAllDone <> 1
      ${If} $BaraDeleteModelsState = ${BST_CHECKED}
      ${AndIf} $PassiveMode <> 1
      ${AndIfNot} ${Silent}
        Call un.BaraDeleteModels
      ${EndIf}
      Call un.BaraDeleteCaches
    ${EndIf}
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
