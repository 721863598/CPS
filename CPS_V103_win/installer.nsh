; CPS Installer Custom Script
; --- 高 DPI 屏幕适配：防止文字/图标模糊 ---
ManifestDPIAware true
ManifestDPIAwareness "PerMonitorV2"

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

; ============================================================
;  自定义简介页（替换默认 MUI_WELCOME 页）
; ============================================================
!macro customWelcomePage
  Page custom fnIntroCreate fnIntroLeave
!macroend

!ifndef BUILD_UNINSTALLER
  Var introDlg
  Var introFontAuthor
!endif

!macro defineIntroFunctions
  Function fnIntroCreate
    nsDialogs::Create 1018
    Pop $introDlg
    ${If} $introDlg == error
      Abort
    ${EndIf}

    ; MUI 标题栏：控件 ID 1037=标题，1038=副标题
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:欢迎使用 CPS 专注计时器"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:版本 ${VERSION}（内测版）"

    ; --- 作者（加粗醒目） ---
    ${NSD_CreateLabel} 0u 0u 100% 14u "作者：王梓赫"
    Pop $0
    CreateFont $introFontAuthor "$(^Font)" "10" "700"
    SendMessage $0 ${WM_SETFONT} $introFontAuthor 1

    ; --- 感谢语 ---
    ${NSD_CreateLabel} 0u 20u 100% 12u "感谢您下载并使用 CPS 专注计时器！"
    Pop $0

    ; --- 内测说明 ---
    ${NSD_CreateLabel} 0u 36u 100% 12u "当前为内测版本，软件仍在持续开发与完善中。"
    Pop $0

    ; --- 反馈邀请 1 ---
    ${NSD_CreateLabel} 0u 52u 100% 12u "若您在体验过程中发现任何问题，或有功能改进方面的建议，"
    Pop $0

    ; --- 反馈邀请 2 ---
    ${NSD_CreateLabel} 0u 68u 100% 12u "欢迎随时反馈，您的每一条意见都将直接影响产品的迭代方向。"
    Pop $0

    ; --- 感谢 ---
    ${NSD_CreateLabel} 0u 84u 100% 12u "衷心感谢每一位内测用户的支持与参与！"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function fnIntroLeave
    ; 无校验，直接进入下一步
  FunctionEnd
!macroend
!ifndef BUILD_UNINSTALLER
  !insertmacro defineIntroFunctions
!endif

; ============================================================
;  用户选择安装目录后，自动追加 "CPS" 产品名
; ============================================================
Function .onVerifyInstDir
  ${GetFileName} $INSTDIR $0
  ${If} $0 != "CPS"
    StrCpy $INSTDIR "$INSTDIR\CPS"
  ${EndIf}
FunctionEnd

; ============================================================
;  安装时：恢复上次卸载时保留的 records
; ============================================================
!macro customInstall
  ${If} ${FileExists} "$INSTDIR\..\CPS_Records\*.*"
    CreateDirectory "$INSTDIR\records"
    CopyFiles /SILENT "$INSTDIR\..\CPS_Records\*.*" "$INSTDIR\records"
    RMDir /r "$INSTDIR\..\CPS_Records"
  ${ElseIf} ${FileExists} "$INSTDIR\..\CPS_Records\records.json"
    CreateDirectory "$INSTDIR\records"
    CopyFiles /SILENT "$INSTDIR\..\CPS_Records\records.json" "$INSTDIR\records"
    Delete "$INSTDIR\..\CPS_Records\records.json"
    RMDir "$INSTDIR\..\CPS_Records"
  ${EndIf}
!macroend

; ============================================================
;  卸载时：将 records 移出安装目录，防止被卸载器删除
; ============================================================
!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\records\*.*"
    CreateDirectory "$INSTDIR\..\CPS_Records"
    CopyFiles /SILENT "$INSTDIR\records\*.*" "$INSTDIR\..\CPS_Records"
  ${EndIf}
!macroend
