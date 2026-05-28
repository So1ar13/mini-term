import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { FileContentResult } from '../types';
import { handleExternalLinkClick } from '../utils/externalLink';

interface FileViewerModalProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  projectRoot: string;
  highlightLine?: number;
}

function isMarkdownFile(path: string) {
  return /\.(md|markdown|mkd|mdx)$/i.test(path);
}

function isImageFile(path: string) {
  return /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif|tiff?)$/i.test(path);
}

function isHtmlFile(path: string) {
  return /\.html?$/i.test(path);
}

const EXT_LANG_MAP: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.json': 'json', '.jsonc': 'json5',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin',
  '.php': 'php', '.lua': 'lua', '.r': 'r', '.R': 'r',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.fish': 'fish',
  '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.dockerfile': 'dockerfile', '.docker': 'dockerfile',
  '.makefile': 'makefile', '.mk': 'makefile',
  '.vim': 'vim', '.vimrc': 'vim',
  '.txt': 'text', '.log': 'text', '.csv': 'text',
};

function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (path.endsWith('Dockerfile')) return 'dockerfile';
  if (path.endsWith('Makefile')) return 'makefile';
  return EXT_LANG_MAP[ext] || 'text';
}

export function FileViewerModal({ open, onClose, filePath, projectRoot, highlightLine }: FileViewerModalProps) {
  const [result, setResult] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isMd = useMemo(() => isMarkdownFile(filePath), [filePath]);
  const isImg = useMemo(() => isImageFile(filePath), [filePath]);
  const isHtml = useMemo(() => isHtmlFile(filePath), [filePath]);
  const [preview, setPreview] = useState(true);
  const [zoom, setZoom] = useState(100);
  const highlightRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.min(200, Math.max(50, prev + delta)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = contentRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleZoom(e.deltaY < 0 ? 10 : -10);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, handleZoom]);

  const htmlSrcDoc = useMemo(() => {
    if (!isHtml || !result?.content) return '';
    const normalized = filePath.replace(/\\/g, '/');
    const fileDir = normalized.substring(0, normalized.lastIndexOf('/'));
    return result.content.replace(
      /((?:src|href|poster)\s*=\s*["'])(?!https?:|data:|blob:|mailto:|tel:|#|javascript:)([^"']+)(["'])/gi,
      (_match, prefix, url, suffix) => prefix + convertFileSrc(fileDir + '/' + url) + suffix
    );
  }, [isHtml, result?.content, filePath]);

  const resolveImgSrc = useCallback((src: string | undefined) => {
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return src;
    const normalized = filePath.replace(/\\/g, '/');
    const fileDir = normalized.substring(0, normalized.lastIndexOf('/'));
    return convertFileSrc(fileDir + '/' + src);
  }, [filePath]);

  useEffect(() => {
    if (!open || isImg) return;
    setLoading(true);
    setError('');
    setResult(null);

    invoke<FileContentResult>('read_file_content', { projectRoot, path: filePath })
      .then(setResult)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, filePath, projectRoot, isImg]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); handleZoom(10); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); handleZoom(-10); }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(100); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, handleZoom]);

  useEffect(() => {
    if (result && highlightLine && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [result, highlightLine]);

  if (!open) return null;

  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center select-text" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative flex flex-col overflow-hidden bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-[var(--radius-md)] shadow-[var(--shadow-overlay)] animate-slide-in"
        style={{ width: '90vw', height: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 工具栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-[var(--accent)]">{fileName}</span>
            <span className="text-sm text-[var(--text-muted)] truncate max-w-[400px]">
              {filePath}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(isMd || isHtml) && result && !result.isBinary && !result.tooLarge && (
              <div className="flex rounded-[var(--radius-sm)] border border-[var(--border-default)] overflow-hidden text-xs">
                <button
                  className={`px-2.5 py-1 transition-colors ${preview ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                  onClick={() => setPreview(true)}
                >
                  预览
                </button>
                <button
                  className={`px-2.5 py-1 transition-colors ${!preview ? 'bg-[var(--accent)] text-[var(--bg-base)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                  onClick={() => setPreview(false)}
                >
                  源码
                </button>
              </div>
            )}
            {!isImg && result && !result.isBinary && !result.tooLarge && (
              <div className="flex items-center gap-1 text-xs">
                <button
                  className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition-colors"
                  onClick={() => handleZoom(-10)}
                  title="缩小 (Ctrl+-)"
                >
                  A-
                </button>
                <button
                  className={`px-1.5 py-0.5 rounded-[var(--radius-sm)] transition-colors ${zoom === 100 ? 'text-[var(--text-muted)]' : 'text-[var(--accent)] hover:bg-[var(--border-subtle)]'}`}
                  onClick={() => setZoom(100)}
                  title="重置缩放"
                >
                  {zoom}%
                </button>
                <button
                  className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition-colors"
                  onClick={() => handleZoom(10)}
                  title="放大 (Ctrl++)"
                >
                  A+
                </button>
              </div>
            )}
            <button
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div ref={contentRef} className="flex-1 overflow-auto bg-[var(--bg-base)]">
          {loading && (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              加载中...
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-[var(--color-error)]">
              {error}
            </div>
          )}
          {isImg && (
            <div className="flex items-center justify-center h-full p-6">
              <img
                src={convertFileSrc(filePath)}
                alt={fileName}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            </div>
          )}
          {!isImg && result && result.isBinary && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--text-muted)]">
              <span>二进制文件，不支持预览</span>
              <button
                className="px-4 py-1.5 text-sm rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
                onClick={() => invoke('open_path_with_default_app', { path: filePath })}
              >
                使用默认工具打开
              </button>
            </div>
          )}
          {!isImg && result && result.tooLarge && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--text-muted)]">
              <span>文件过大（&gt;1MB），不支持预览</span>
              <button
                className="px-4 py-1.5 text-sm rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
                onClick={() => invoke('open_path_with_default_app', { path: filePath })}
              >
                使用默认工具打开
              </button>
            </div>
          )}
          {!isImg && result && !result.isBinary && !result.tooLarge && isHtml && preview ? (
            <iframe
              srcDoc={htmlSrcDoc}
              title={fileName}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-same-origin"
            />
          ) : !isImg && result && !result.isBinary && !result.tooLarge && isMd && preview ? (
            <div className="md-preview p-6 max-w-[860px] mx-auto" style={{ fontSize: `${zoom}%` }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={{
                  img: ({ src, alt, ...props }) => (
                    <img src={resolveImgSrc(src)} alt={alt ?? ''} {...props} />
                  ),
                  a: ({ href, children, ...props }) => (
                    <a href={href} onClick={handleExternalLinkClick} {...props}>{children}</a>
                  ),
                }}
              >
                {result.content}
              </ReactMarkdown>
            </div>
          ) : !isImg && result && !result.isBinary && !result.tooLarge && (
            <SyntaxHighlighter
              language={detectLanguage(filePath)}
              style={oneDark}
              showLineNumbers
              wrapLines
              wrapLongLines
              lineNumberStyle={{ minWidth: '3em', paddingRight: '1em', opacity: 0.4 }}
              customStyle={{ margin: 0, borderRadius: 0, background: 'var(--bg-base)', fontSize: `${zoom * 0.00875}rem`, lineHeight: '1.5' }}
              lineProps={(lineNumber) => ({
                ref: lineNumber === highlightLine ? highlightRef : undefined,
                style: lineNumber === highlightLine ? { backgroundColor: 'var(--accent-muted)' } : undefined,
              })}
            >
              {result.content}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
    </div>
  );
}
