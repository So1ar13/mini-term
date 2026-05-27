use std::fs;
use std::path::PathBuf;

/// 简单的调试日志命令，前端调用后输出到 stderr
#[tauri::command]
pub fn debug_log(msg: String) {
    eprintln!("[frontend] {}", msg);
}

/// 读取 shell 历史记录文件，返回命令列表（按时间倒序，最新在前）。
///
/// 根据 `shell_command` 判断 shell 类型，读取对应的历史文件：
/// - bash → `~/.bash_history`
/// - zsh  → `~/.zsh_history`
/// - fish → `~/.local/share/fish/fish_history`
/// - powershell/pwsh → PSReadLine ConsoleHost_history.txt
/// - cmd  → 无历史文件支持，返回空
#[tauri::command]
pub fn read_shell_history(shell_command: String) -> Vec<String> {
    eprintln!("[shell_history] called with shell_command=\"{}\"", shell_command);
    let path = match resolve_history_path(&shell_command) {
        Some(p) => p,
        None => {
            eprintln!("[shell_history] no history path resolved for \"{}\"", shell_command);
            return vec![];
        }
    };

    eprintln!("[shell_history] resolved path: {}", path.display());
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[shell_history] failed to read {}: {}", path.display(), e);
            return vec![];
        }
    };

    let result = parse_history(&shell_command, &content);
    eprintln!("[shell_history] parsed {} entries", result.len());
    result
}

fn resolve_history_path(shell_cmd: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let lower = shell_cmd.to_lowercase();

    if lower.contains("zsh") {
        Some(home.join(".zsh_history"))
    } else if lower.contains("bash") {
        Some(home.join(".bash_history"))
    } else if lower.contains("fish") {
        Some(home.join(".local/share/fish/fish_history"))
    } else if lower.contains("powershell") || lower.contains("pwsh") {
        // PSReadLine 默认路径（最常见）
        let appdata = std::env::var("APPDATA").ok();
        if let Some(ref appdata) = appdata {
            let psreadline = PathBuf::from(appdata)
                .join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt");
            if psreadline.exists() {
                return Some(psreadline);
            }
        }
        // PowerShell 7+ (pwsh) 文档目录
        let pwsh_path = home.join("Documents/PowerShell/ConsoleHost_history.txt");
        if pwsh_path.exists() {
            return Some(pwsh_path);
        }
        // Windows PowerShell 5.x 文档目录
        let win_ps_path = home.join("Documents/WindowsPowerShell/ConsoleHost_history.txt");
        if win_ps_path.exists() {
            return Some(win_ps_path);
        }
        // 回退：尝试 APPDATA 路径（即使文件不存在，让调用方处理）
        if let Some(appdata) = appdata {
            return Some(
                PathBuf::from(appdata)
                    .join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
            );
        }
        None
    } else {
        // cmd 等不支持
        None
    }
}

fn parse_history(shell_cmd: &str, content: &str) -> Vec<String> {
    let lower = shell_cmd.to_lowercase();

    if lower.contains("zsh") {
        parse_zsh_history(content)
    } else if lower.contains("fish") {
        parse_fish_history(content)
    } else {
        // bash / powershell 逐行
        parse_line_based_history(content)
    }
}

/// zsh_history 格式（extended_history）：
///   `: 1623456789:0;command`
/// 或普通格式直接一行一条命令。
fn parse_zsh_history(content: &str) -> Vec<String> {
    let mut commands: Vec<String> = Vec::new();
    for line in content.lines() {
        let cmd = if line.starts_with(": ") {
            // extended_history: `: timestamp:duration;command`
            line.find(';')
                .map(|pos| &line[pos + 1..])
                .unwrap_or(line)
        } else {
            line
        };
        let trimmed = cmd.trim();
        if !trimmed.is_empty() {
            commands.push(trimmed.to_string());
        }
    }
    commands.reverse();
    commands
}

/// fish_history 格式：
///   `- cmd: command`
///   之间有 `- when: timestamp` 等元数据行。
fn parse_fish_history(content: &str) -> Vec<String> {
    let mut commands: Vec<String> = Vec::new();
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("- cmd: ") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                commands.push(trimmed.to_string());
            }
        }
    }
    commands.reverse();
    commands
}

/// bash / powershell：一行一条命令。
fn parse_line_based_history(content: &str) -> Vec<String> {
    let mut commands: Vec<String> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            commands.push(trimmed.to_string());
        }
    }
    commands.reverse();
    commands
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_bash_history() {
        let content = "ls -la\ncd /tmp\nls -la\necho hello\n";
        let result = parse_line_based_history(content);
        assert_eq!(result, vec!["echo hello", "ls -la", "cd /tmp", "ls -la"]);
    }

    #[test]
    fn test_parse_zsh_extended_history() {
        let content = ": 1623456789:0;ls -la\n: 1623456790:0;cd /tmp\n: 1623456791:0;echo hello\n";
        let result = parse_zsh_history(content);
        assert_eq!(result, vec!["echo hello", "cd /tmp", "ls -la"]);
    }

    #[test]
    fn test_parse_zsh_plain_history() {
        let content = "ls -la\ncd /tmp\n";
        let result = parse_zsh_history(content);
        assert_eq!(result, vec!["cd /tmp", "ls -la"]);
    }

    #[test]
    fn test_parse_fish_history() {
        let content = "- cmd: ls -la\n  when: 1623456789\n- cmd: cd /tmp\n  when: 1623456790\n";
        let result = parse_fish_history(content);
        assert_eq!(result, vec!["cd /tmp", "ls -la"]);
    }

    #[test]
    fn test_parse_empty_history() {
        let result = parse_line_based_history("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_history_skips_blank_lines() {
        let content = "ls\n\n  \ncd /tmp\n\n";
        let result = parse_line_based_history(content);
        assert_eq!(result, vec!["cd /tmp", "ls"]);
    }
}
