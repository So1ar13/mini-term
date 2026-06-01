import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId, saveLayoutToConfig } from '../store';
import { showContextMenu } from '../utils/contextMenu';
import { showConfirm, showPrompt } from '../utils/prompt';
import { registerShellCommand, writePtyInput, isAiPty } from '../utils/terminalCache';
import { getProjectEnvs } from '../utils/projectEnv';
import { SessionViewerModal } from './SessionViewerModal';
import type { AiSession, SplitNode, PaneState } from '../types';

const PAGE_SIZE = 20;

/** 将 ISO 时间戳转换为简短的相对/绝对时间 */
function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';

  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;

  // 超过一周显示日期
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = date.getFullYear();
  const currentYear = new Date().getFullYear();
  return y === currentYear ? `${m}月${d}日` : `${y}/${m}/${d}`;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: 'C', color: 'var(--color-ai)' },
  codex: { label: 'X', color: 'var(--color-success)' },
};

function sessionNicknameKey(session: AiSession): string {
  return `${session.sessionType}:${session.id}`;
}

/** 从 SplitNode 树中找到 activePaneId 对应的 pane */
function findActivePane(node: SplitNode): { pane: { id: string; shellName: string; customTitle?: string; ptyId?: number }; path: number[] } | undefined {
  if (node.type === 'leaf') {
    const pane = node.panes.find((p) => p.id === node.activePaneId);
    return pane ? { pane, path: [] } : undefined;
  }
  for (let i = 0; i < node.children.length; i++) {
    const result = findActivePane(node.children[i]);
    if (result) return { ...result, path: [i, ...result.path] };
  }
  return undefined;
}

/** 递归找到包含 targetPaneId 的 leaf，将 newPane 添加到其 panes 数组并设为 activePaneId */
function addPaneToActiveLeaf(node: SplitNode, targetPaneId: string, newPane: PaneState): SplitNode {
  if (node.type === 'leaf') {
    if (node.panes.some((p) => p.id === targetPaneId)) {
      return {
        ...node,
        panes: [...node.panes, newPane],
        activePaneId: newPane.id,
      };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((c) => addPaneToActiveLeaf(c, targetPaneId, newPane)),
  };
}

/** 递归更新 SplitNode 中指定 pane 的 customTitle */
function renamePaneInTree(node: SplitNode, paneId: string, customTitle: string | undefined): SplitNode {
  if (node.type === 'leaf') {
    return {
      ...node,
      panes: node.panes.map((p) => p.id === paneId ? { ...p, customTitle } : p),
    };
  }
  return {
    ...node,
    children: node.children.map((c) => renamePaneInTree(c, paneId, customTitle)),
  };
}

export function SessionList() {
  const config = useAppStore((s) => s.config);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projectStates = useAppStore((s) => s.projectStates);
  const updateTabLayout = useAppStore((s) => s.updateTabLayout);
  const updateConfig = useAppStore((s) => s.setConfig);

  const [allSessions, setAllSessions] = useState<AiSession[]>([]);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [viewingSession, setViewingSession] = useState<AiSession | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeProject = config.projects.find((p) => p.id === activeProjectId);

  const fetchSessions = useCallback(async (projectPath: string) => {
    setLoading(true);
    try {
      const result = await invoke<AiSession[]>('get_ai_sessions', { projectPath });
      setAllSessions(result);
      setDisplayCount(PAGE_SIZE);
    } catch {
      setAllSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeProject?.path) {
      fetchSessions(activeProject.path);
    } else {
      setAllSessions([]);
      setDisplayCount(PAGE_SIZE);
    }
  }, [activeProject?.path, fetchSessions]);

  const visibleSessions = allSessions.slice(0, displayCount);
  const hasMore = displayCount < allSessions.length;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || loading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      setDisplayCount((c) => Math.min(c + PAGE_SIZE, allSessions.length));
    }
  }, [hasMore, loading, allSessions.length]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-surface)] select-none">
      <div className="px-3 pt-2.5 pb-1.5 text-sm text-[var(--text-muted)] uppercase tracking-[0.12em] font-medium flex items-center justify-between">
        <span>Sessions</span>
        {activeProject && (
          <span
            className="text-xs normal-case tracking-normal cursor-pointer hover:text-[var(--text-primary)] transition-colors"
            onClick={() => fetchSessions(activeProject.path)}
            title="刷新会话列表"
          >
            ↻
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1.5" onScroll={handleScroll}>
        {loading && allSessions.length === 0 && (
          <div className="px-2.5 py-3 text-xs text-[var(--text-muted)] text-center">加载中…</div>
        )}

        {!loading && allSessions.length === 0 && (
          <div className="px-2.5 py-3 text-xs text-[var(--text-muted)] text-center">
            {activeProject ? '暂无会话记录' : '请先选择项目'}
          </div>
        )}

        <SessionViewerModal
          open={!!viewingSession}
          onClose={() => setViewingSession(null)}
          session={viewingSession}
          projectPath={activeProject?.path ?? ''}
        />

        {visibleSessions.map((session) => {
          const badge = TYPE_BADGE[session.sessionType] ?? TYPE_BADGE.claude;

          return (
            <div
              key={`${session.sessionType}-${session.id}`}
              className="flex items-start gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs group hover:bg-[var(--border-subtle)] transition-colors cursor-default"
              title={config.sessionNicknames?.[sessionNicknameKey(session)] || session.title}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const cmd = session.sessionType === 'claude'
                  ? `claude --resume ${session.id}`
                  : `codex resume ${session.id}`;
                const resumeWithPerms = session.sessionType === 'claude'
                  ? `claude --resume ${session.id} --permission-mode bypassPermissions`
                  : `codex resume ${session.id}`;
                const nicknameKey = sessionNicknameKey(session);
                const currentNickname = config.sessionNicknames?.[nicknameKey] || '';

                const sessionName = currentNickname || session.title;

                const writeCmdToTerminal = async (command: string) => {
                  if (!activeProjectId) return;
                  const ps = projectStates.get(activeProjectId);
                  const activeTab = ps?.tabs.find((t) => t.id === ps.activeTabId);
                  const activeResult = activeTab ? findActivePane(activeTab.splitLayout) : undefined;
                  const ptyId = activeResult?.pane.ptyId;

                  if (ptyId !== undefined && !isAiPty(ptyId)) {
                    await writePtyInput(ptyId, command);
                    // 已有终端：询问是否同步重命名
                    const ok = await showConfirm('同步重命名终端', `是否将终端名称同步为「${sessionName}」？`);
                    if (ok && activeTab && activeResult) {
                      const newLayout = renamePaneInTree(activeTab.splitLayout, activeResult.pane.id, sessionName);
                      updateTabLayout(activeProjectId, activeTab.id, newLayout);
                      saveLayoutToConfig(activeProjectId);
                    }
                  } else if (activeProject) {
                    const shell = config.availableShells.find((s) => s.name === config.defaultShell)
                      ?? config.availableShells[0];
                    if (!shell) return;
                    const newPtyId = await invoke<number>('create_pty', {
                      shell: shell.command,
                      args: shell.args ?? [],
                      cwd: activeProject.path,
                      envs: getProjectEnvs(activeProjectId),
                    });
                    registerShellCommand(newPtyId, shell.command);
                    // 在当前 leaf 的 tab 栏新增一个 pane
                    const ps = projectStates.get(activeProjectId);
                    const currentTab = ps?.tabs.find((t) => t.id === ps.activeTabId);
                    if (currentTab) {
                      const activePaneResult = findActivePane(currentTab.splitLayout);
                      const targetPaneId = activePaneResult?.pane.id;
                      if (targetPaneId) {
                        const newPane: PaneState = {
                          id: genId(),
                          shellName: shell.name,
                          customTitle: sessionName,
                          status: 'idle',
                          ptyId: newPtyId,
                        };
                        const newLayout = addPaneToActiveLeaf(currentTab.splitLayout, targetPaneId, newPane);
                        updateTabLayout(activeProjectId, currentTab.id, newLayout);
                        saveLayoutToConfig(activeProjectId);
                        await writePtyInput(newPtyId, command);
                      }
                    }
                  }
                };

                showContextMenu(e.clientX, e.clientY, [
                  {
                    label: '查看',
                    onClick: () => setViewingSession(session),
                  },
                  { separator: true },
                  {
                    label: '恢复',
                    onClick: () => writeCmdToTerminal(cmd),
                  },
                  { separator: true },
                  {
                    label: '恢复（授予权限）',
                    onClick: () => writeCmdToTerminal(resumeWithPerms),
                  },
                  { separator: true },
                  {
                    label: '重命名',
                    onClick: async () => {
                      const name = await showPrompt('重命名会话', '输入新名称', currentNickname || session.title);
                      if (name === null) return;
                      const trimmed = name.trim();
                      const newNicknames = { ...(config.sessionNicknames ?? {}) };
                      if (trimmed && trimmed !== session.title) {
                        newNicknames[nicknameKey] = trimmed;
                      } else {
                        delete newNicknames[nicknameKey];
                      }
                      const newConfig = { ...config, sessionNicknames: newNicknames };
                      updateConfig(newConfig);
                      invoke('save_config', { config: newConfig }).catch(() => {});
                    },
                  },
                  { separator: true },
                  {
                    label: '删除',
                    danger: true,
                    onClick: async () => {
                      const ok = await showConfirm('删除会话', `确定删除此会话？此操作不可撤销。`);
                      if (!ok) return;
                      try {
                        await invoke('delete_ai_session', {
                          sessionType: session.sessionType,
                          sessionId: session.id,
                          projectPath: activeProject?.path ?? '',
                        });
                        if (activeProject?.path) fetchSessions(activeProject.path);
                      } catch (e) {
                        console.error('删除会话失败:', e);
                      }
                    },
                  },
                ]);
              }}
            >
              {/* 类型徽标 */}
              <span
                className="flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold mt-0.5"
                style={{ backgroundColor: badge.color + '22', color: badge.color }}
              >
                {badge.label}
              </span>

              {/* 标题 + 时间 */}
              <div className="flex-1 min-w-0">
                <div className="truncate text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors leading-snug">
                  {config.sessionNicknames?.[sessionNicknameKey(session)] || session.title}
                </div>
                <div className="text-[var(--text-muted)] text-[10px] mt-0.5 leading-none">
                  {formatTime(session.timestamp)}
                </div>
              </div>
            </div>
          );
        })}

        {hasMore && (
          <div className="px-2.5 py-2 text-[10px] text-[var(--text-muted)] text-center">
            {allSessions.length - displayCount} 条更多…
          </div>
        )}
      </div>
    </div>
  );
}
