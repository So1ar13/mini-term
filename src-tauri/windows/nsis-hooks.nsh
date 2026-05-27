!macro NSIS_HOOK_POSTINSTALL
  ; 注册右键菜单「用 Mini-Term 打开」
  ; 文件夹右键
  WriteRegStr HKCU "Software\Classes\Directory\shell\miniterm" "" "用 Mini-Term 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\miniterm" "Icon" "$INSTDIR\Mini-Term.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\miniterm\command" "" '"$INSTDIR\Mini-Term.exe" "%1"'
  ; 文件夹内空白处右键
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\miniterm" "" "用 Mini-Term 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\miniterm" "Icon" "$INSTDIR\Mini-Term.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\miniterm\command" "" '"$INSTDIR\Mini-Term.exe" "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 清理右键菜单注册表项
  DeleteRegKey HKCU "Software\Classes\Directory\shell\miniterm"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\miniterm"
!macroend
