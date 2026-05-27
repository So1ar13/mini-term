#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
const REGISTRY_PATH: &str = "Software\\Classes\\Directory\\shell\\miniterm";
#[cfg(windows)]
const REGISTRY_BG_PATH: &str = "Software\\Classes\\Directory\\Background\\shell\\miniterm";

/// 注册 Windows 右键菜单「用 Mini-Term 打开」
/// 写入 HKCU 注册表键，包含文件夹右键和文件夹内空白处右键
#[tauri::command]
pub fn register_context_menu(exe_path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 文件夹右键菜单
        let (key, _) = hkcu.create_subkey(REGISTRY_PATH).map_err(|e| e.to_string())?;
        key.set_value("", &"用 Mini-Term 打开").map_err(|e| e.to_string())?;
        key.set_value("Icon", &exe_path).map_err(|e| e.to_string())?;

        let (cmd_key, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
        let cmd = format!("\"{}\" \"%1\"", exe_path);
        cmd_key.set_value("", &cmd).map_err(|e| e.to_string())?;

        // 文件夹内空白处右键菜单
        let (bg_key, _) = hkcu.create_subkey(REGISTRY_BG_PATH).map_err(|e| e.to_string())?;
        bg_key.set_value("", &"用 Mini-Term 打开").map_err(|e| e.to_string())?;
        bg_key.set_value("Icon", &exe_path).map_err(|e| e.to_string())?;

        let (bg_cmd_key, _) = bg_key.create_subkey("command").map_err(|e| e.to_string())?;
        let bg_cmd = format!("\"{}\" \"%V\"", exe_path);
        bg_cmd_key.set_value("", &bg_cmd).map_err(|e| e.to_string())?;

        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("右键菜单注册仅支持 Windows".to_string())
    }
}

/// 取消注册 Windows 右键菜单
#[tauri::command]
pub fn unregister_context_menu() -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.delete_subkey_all(REGISTRY_PATH).map_err(|e| e.to_string())?;
        hkcu.delete_subkey_all(REGISTRY_BG_PATH).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("右键菜单注册仅支持 Windows".to_string())
    }
}

/// 检查右键菜单是否已注册
#[tauri::command]
pub fn is_context_menu_registered() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match hkcu.open_subkey(REGISTRY_PATH) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// 获取当前可执行文件路径
#[tauri::command]
pub fn get_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}
