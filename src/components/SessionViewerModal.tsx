import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { MOD_LABEL } from '../utils/platform';
import { handleExternalLinkClick } from '../utils/externalLink';
import type { AiSession, AiSessionMessage } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  session: AiSession | null;
  projectPath: string;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-[var(--color-warning,#f59e0b)]/40 text-inherit rounded-[2px] px-[1px]">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SessionViewerModal({ open, onClose, session, projectPath }: Props) {
  const [messages, setMessages] = useState<AiSessionMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const [userIdx, setUserIdx] = useState(-1);
  const [chatLayout, setChatLayout] = useState(true);

  const msgRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !session) return;
    setLoading(true);
    setError('');
    setMessages([]);
    setSearch('');
    setMatchIdx(0);
    setUserIdx(-1);

    invoke<AiSessionMessage[]>('get_ai_session_content', {
      sessionType: session.sessionType,
      sessionId: session.id,
      projectPath,
    })
      .then((msgs) => {
        setMessages(msgs);
        msgRefs.current = new Array(msgs.length).fill(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, session, projectPath]);

  const userIndices = useMemo(
    () => messages.reduce<number[]>((acc, m, i) => { if (m.role === 'user') acc.push(i); return acc; }, []),
    [messages],
  );

  const [hoveredDot, setHoveredDot] = useState<number | null>(null);

  const q = search.trim().toLowerCase();

  const matchIndices = useMemo(() => {
    if (!q) return [];
    return messages.reduce<number[]>((acc, m, i) => {
      if (m.content.toLowerCase().includes(q)) acc.push(i);
      return acc;
    }, []);
  }, [messages, q]);

  useEffect(() => {
    setMatchIdx(0);
    if (matchIndices.length > 0) {
      msgRefs.current[matchIndices[0]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [matchIndices]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (search) {
          setSearch('');
        } else {
          onClose();
        }
      } else if (e.key === 'Enter' && document.activeElement === searchRef.current) {
        e.preventDefault();
        if (matchIndices.length === 0) return;
        const dir = e.shiftKey ? -1 : 1;
        setMatchIdx((prev) => {
          const next = (prev + dir + matchIndices.length) % matchIndices.length;
          msgRefs.current[matchIndices[next]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return next;
        });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose, search, matchIndices]);

  const goMatch = (dir: 1 | -1) => {
    if (matchIndices.length === 0) return;
    const next = (matchIdx + dir + matchIndices.length) % matchIndices.length;
    setMatchIdx(next);
    msgRefs.current[matchIndices[next]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const goUser = (dir: 1 | -1) => {
    if (userIndices.length === 0) return;
    let next: number;
    if (userIdx < 0) {
      next = dir === 1 ? 0 : userIndices.length - 1;
    } else {
      next = (userIdx + dir + userIndices.length) % userIndices.length;
    }
    setUserIdx(next);
    msgRefs.current[userIndices[next]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const exportSession = async () => {
    if (messages.length === 0) return;
    const typeName = session?.sessionType === 'claude' ? 'Claude' : 'Codex';
    const lines = [
      `# ${typeName} Session: ${session?.title ?? ''}`,
      `Exported: ${new Date().toISOString()}`,
      `Messages: ${messages.length}`,
      '',
      '---',
      '',
    ];
    for (const msg of messages) {
      const role = msg.role === 'user' ? '## User' : '## Assistant';
      const time = msg.timestamp ? ` (${formatTime(msg.timestamp)})` : '';
      lines.push(`${role}${time}`, '', msg.content, '', '---', '');
    }
    const content = lines.join('\n');
    const defaultName = `${session?.title ?? 'session'}.md`.replace(/[<>:"/\\|?*]/g, '_');
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    });
    if (!filePath) return;
    await invoke('write_text_file', { path: filePath, content });
  };

  if (!open || !session) return null;

  const typeName = session.sessionType === 'claude' ? 'Claude' : 'Codex';
  const typeColor = session.sessionType === 'claude' ? 'var(--color-ai)' : 'var(--color-success)';
  const isMatch = (i: number) => q && matchIndices.includes(i);
  const isCurrentMatch = (i: number) => q && matchIndices[matchIdx] === i;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center select-text" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative flex flex-col overflow-hidden bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-[var(--radius-md)] shadow-[var(--shadow-overlay)] animate-slide-in"
        style={{ width: '90vw', height: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-subtle)] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="flex-shrink-0 text-xs font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: typeColor + '22', color: typeColor }}
            >
              {typeName}
            </span>
            <span className="text-base font-medium text-[var(--text-primary)] truncate">{session.title}</span>
            {messages.length > 0 && (
              <span className="text-xs text-[var(--text-muted)] flex-shrink-0">{messages.length} 条消息</span>
            )}
          </div>

          <div className="flex items-center gap-3 flex-shrink-0 ml-2">
            {/* 布局切换 */}
            <div className="flex rounded-[var(--radius-sm)] border border-[var(--border-default)] overflow-hidden text-xs">
              <button
                className={`px-2 py-1 transition-colors ${chatLayout ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                onClick={() => setChatLayout(true)}
                title="对话布局"
              >
                对话
              </button>
              <button
                className={`px-2 py-1 transition-colors ${!chatLayout ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                onClick={() => setChatLayout(false)}
                title="列表布局"
              >
                列表
              </button>
            </div>
            {/* 导出按钮 */}
            {messages.length > 0 && (
              <button
                className="px-2 py-0.5 rounded-[var(--radius-sm)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition-colors"
                onClick={exportSession}
                title="导出为文件"
              >
                导出
              </button>
            )}
            {/* User 消息快速导航 */}
            {userIndices.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <button className="hover:text-[var(--text-primary)] transition-colors px-0.5" onClick={() => goUser(-1)} title="上一个用户消息">
                  ▲
                </button>
                <span className="min-w-[4em] text-center">
                  User {userIdx >= 0 ? userIdx + 1 : '-'}/{userIndices.length}
                </span>
                <button className="hover:text-[var(--text-primary)] transition-colors px-0.5" onClick={() => goUser(1)} title="下一个用户消息">
                  ▼
                </button>
              </div>
            )}
            <button className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {/* 搜索栏 */}
        {messages.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border-subtle)] flex-shrink-0 bg-[var(--bg-surface)]">
            <span className="text-xs text-[var(--text-muted)]">🔍</span>
            <input
              ref={searchRef}
              type="text"
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              placeholder={`搜索消息内容… (${MOD_LABEL}+F)`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {q && (
              <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                {matchIndices.length > 0 ? (
                  <>
                    <button className="hover:text-[var(--text-primary)] px-0.5" onClick={() => goMatch(-1)}>◀</button>
                    <span>{matchIdx + 1}/{matchIndices.length}</span>
                    <button className="hover:text-[var(--text-primary)] px-0.5" onClick={() => goMatch(1)}>▶</button>
                  </>
                ) : (
                  <span>无匹配</span>
                )}
                <button className="hover:text-[var(--text-primary)] ml-1 px-0.5" onClick={() => setSearch('')}>✕</button>
              </div>
            )}
          </div>
        )}

        {/* 消息列表 + 时间轴 */}
        <div className="flex-1 flex overflow-hidden bg-[var(--bg-base)]">
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {loading && <div className="flex items-center justify-center h-full text-[var(--text-muted)]">加载中...</div>}
            {error && <div className="flex items-center justify-center h-full text-[var(--color-error)]">{error}</div>}
            {!loading && !error && messages.length === 0 && (
              <div className="flex items-center justify-center h-full text-[var(--text-muted)]">无消息内容</div>
            )}

            {messages.map((msg, i) => {
              const isUser = msg.role === 'user';
              const matchRing = isCurrentMatch(i) ? 'ring-2 ring-[var(--color-warning,#f59e0b)] rounded-[var(--radius-sm)]' : '';
              const dimStyle = q && !isMatch(i) ? { opacity: 0.35 } : undefined;

              if (chatLayout) {
                return (
                  <div
                    key={i}
                    ref={(el) => { msgRefs.current[i] = el; }}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${matchRing}`}
                    style={dimStyle}
                  >
                    <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
                      <div className="flex items-center gap-2 mb-1" style={{ flexDirection: isUser ? 'row-reverse' : 'row' }}>
                        <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--text-secondary)' : typeColor }}>
                          {isUser ? 'User' : 'Assistant'}
                        </span>
                        {msg.timestamp && <span className="text-[10px] text-[var(--text-muted)]">{formatTime(msg.timestamp)}</span>}
                      </div>
                      <div
                        className={`rounded-[var(--radius-md)] px-3 py-2 text-sm ${
                          isUser
                            ? 'bg-[var(--accent)] text-[var(--bg-base)]'
                            : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)]'
                        }`}
                        style={{ borderTopRightRadius: isUser ? '2px' : undefined, borderTopLeftRadius: !isUser ? '2px' : undefined }}
                      >
                        {msg.role === 'assistant' ? (
                          <div className="md-preview">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}
                              components={{ a: ({ href, children, ...props }) => <a href={href} onClick={handleExternalLinkClick} {...props}>{children}</a> }}
                            >{msg.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {q ? <HighlightText text={msg.content} query={search.trim()} /> : msg.content}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              // 列表布局
              return (
                <div
                  key={i}
                  ref={(el) => { msgRefs.current[i] = el; }}
                  className={matchRing}
                  style={dimStyle}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold" style={{ color: isUser ? 'var(--text-secondary)' : typeColor }}>
                      {isUser ? 'User' : 'Assistant'}
                    </span>
                    {msg.timestamp && <span className="text-[10px] text-[var(--text-muted)]">{formatTime(msg.timestamp)}</span>}
                  </div>
                  <div
                    className={`rounded-[var(--radius-sm)] px-3 py-2 text-sm ${
                      isUser
                        ? 'bg-[var(--border-subtle)] text-[var(--text-primary)]'
                        : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-default)]'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="md-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}
                          components={{ a: ({ href, children, ...props }) => <a href={href} onClick={handleExternalLinkClick} {...props}>{children}</a> }}
                        >{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {q ? <HighlightText text={msg.content} query={search.trim()} /> : msg.content}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 右侧时间轴 */}
          {chatLayout && userIndices.length > 1 && (
            <div className="relative w-8 flex-shrink-0 border-l border-[var(--border-subtle)]">
              <div className="absolute inset-0 flex flex-col justify-between py-4 px-1.5">
                {userIndices.map((msgIdx, dotIdx) => (
                  <div
                    key={dotIdx}
                    className="relative flex items-center justify-center cursor-pointer group"
                    onMouseEnter={() => setHoveredDot(dotIdx)}
                    onMouseLeave={() => setHoveredDot(null)}
                    onClick={() => {
                      setUserIdx(dotIdx);
                      msgRefs.current[msgIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full transition-all ${
                        userIdx === dotIdx
                          ? 'bg-[var(--accent)] scale-125'
                          : 'bg-[var(--text-muted)]/40 group-hover:bg-[var(--accent)]/70 group-hover:scale-110'
                      }`}
                    />
                    {/* Tooltip */}
                    {hoveredDot === dotIdx && (
                      <div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 z-10 w-56 max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-overlay)] px-3 py-2 text-xs text-[var(--text-primary)] whitespace-pre-wrap break-words pointer-events-none">
                        {messages[msgIdx].content.slice(0, 200)}{messages[msgIdx].content.length > 200 ? '...' : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
