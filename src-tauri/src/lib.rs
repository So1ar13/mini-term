mod ai_sessions;
mod clipboard;
mod config;
mod editor;
mod fs;
mod git;
mod hook_registry;
mod hook_server;
mod process_monitor;
mod pty;
mod search;
mod shell_history;
mod ssh;
mod shell_integration;
mod ssh_mcp_registry;
mod window_theme;

use tauri::{Emitter, Manager};

#[cfg(windows)]
extern "system" {
    fn ReleaseCapture() -> i32;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

#[cfg(windows)]
const VK_LBUTTON: i32 = 0x01;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 第二个实例启动时，将文件夹路径转发给已有窗口
            if args.len() > 1 {
                let folder_path = args[1].clone();
                // 激活主窗口
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
                // 发送事件给前端
                let _ = app.emit("open-project", &folder_path);
            } else {
                // 没有参数时只是激活窗口
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty::PtyManager::new())
        .manage(fs::FsWatcherManager::new())
        .manage(search::SearchManager::new())
        .setup(|app| {
            // identifier 从 com.tauri-app.tauri-app 切换为 com.mini-term.app 后,
            // 第一次启动时把旧 app_data_dir 下的 config.json 拷到新目录,
            // 必须发生在任何 read_config 之前。
            config::migrate_legacy_app_data(app.handle());
            clipboard::cleanup_old_clipboard_images();
            ssh::cleanup_ssh_temp_keys();

            // 首次启动时检查是否有命令行参数（从右键菜单启动）
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                let folder_path = args[1].clone();
                // 延迟发送事件，等前端准备好
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = app_handle.emit("open-project", &folder_path);
                });
            }

            // 初始化 hook 状态并注册为 Tauri managed state
            let hook_state = hook_server::HookState::new();
            app.manage(hook_state.clone());

            // 读取配置，仅当 hookEnabled == true 时才启动 hook server
            let app_config = config::read_config(app.handle());
            if app_config.hook_enabled {
                if let Err(e) =
                    hook_server::start_hook_server(app.handle().clone(), hook_state.clone())
                {
                    eprintln!("[setup] hook server 启动失败: {}", e);
                }
            }

            // 启动进程监控（传入 hook_state 实现 hook 优先 + 轮询降级）
            let pty_manager = app.state::<crate::pty::PtyManager>();
            let pty_clone = pty_manager.inner().clone();
            process_monitor::start_monitor(app.handle().clone(), pty_clone, hook_state);
            Ok(())
        })
        .on_window_event(|_window, event| {
            // 窗口失焦时释放鼠标捕获，防止外部工具（截图等）与 WebView2
            // 事件处理冲突导致输入锁定。
            // 但若用户正按住左键发起 modal move/size loop（拖拽标题栏 /
            // 窗口边缘 resize），WebView2 子窗口会失焦触发该事件，此时
            // ReleaseCapture 会取消系统的鼠标捕获并立即终止 modal loop，
            // 表现为拖拽和 resize "光标变化但不生效"。
            // 因此左键按下时跳过释放，留给系统自然处理；松开时再释放。
            if let tauri::WindowEvent::Focused(false) = event {
                #[cfg(windows)]
                unsafe {
                    if (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) == 0 {
                        ReleaseCapture();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            pty::create_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::arm_ssh_autofill,
            ssh::prepare_ssh_key,
            fs::list_directory,
            fs::watch_directory,
            fs::unwatch_directory,
            fs::create_file,
            fs::create_directory,
            fs::read_file_content,
            fs::write_file_content,
            fs::write_text_file,
            fs::rename_entry,
            fs::delete_entry,
            fs::filter_directories,
            ai_sessions::get_ai_sessions,
            ai_sessions::get_ai_session_content,
            ai_sessions::delete_ai_session,
            git::get_git_status,
            git::get_git_diff,
            git::discover_git_repos,
            git::get_git_log,
            git::get_repo_branches,
            git::get_commit_files,
            git::get_commit_file_diff,
            git::git_pull,
            git::git_push,
            git::get_changes_status,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_discard_file,
            editor::open_in_editor,
            editor::open_path_with_default_app,
            clipboard::read_clipboard_image,
            clipboard::save_clipboard_text,
            search::start_search,
            search::cancel_search,
            hook_registry::register_ai_hooks,
            hook_registry::unregister_ai_hooks,
            hook_registry::get_hook_config_snippet,
            hook_registry::get_hook_status,
            hook_server::toggle_hook_server,
            shell_history::read_shell_history,
            shell_history::debug_log,
            ssh_mcp_registry::enable_ssh_mcp,
            ssh_mcp_registry::disable_ssh_mcp,
            shell_integration::register_context_menu,
            shell_integration::unregister_context_menu,
            shell_integration::is_context_menu_registered,
            shell_integration::get_exe_path,
            window_theme::set_window_dark_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
