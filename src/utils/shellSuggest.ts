/**
 * Shell 命令自动补全 —— 类 Warp / fish 风格的内联 ghost text 建议。
 *
 * - 输入时显示 inline ghost text（单条建议）
 * - 按上方向键弹出历史命令列表面板，可上下选择
 * - 按右方向键接受当前建议
 */

import { Terminal } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentLineSnapshotFromBuffer } from './terminalSnapshot';

// ---------------------------------------------------------------------------
// History management
// ---------------------------------------------------------------------------

const historyByShell = new Map<string, string[]>();
let loadPromise: Promise<void> | null = null;

async function loadHistory(shellCommand: string): Promise<string[]> {
  try {
    return await invoke<string[]>('read_shell_history', { shellCommand });
  } catch {
    return [];
  }
}

export async function ensureHistoryLoaded(shellCommand: string): Promise<void> {
  if (historyByShell.has(shellCommand)) return;
  if (!loadPromise) {
    loadPromise = loadHistory(shellCommand).then((lines) => {
      historyByShell.set(shellCommand, lines);
      loadPromise = null;
    });
  }
  await loadPromise;
}

export function appendToHistory(shellCommand: string, command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  const history = historyByShell.get(shellCommand);
  if (!history) return;
  if (history.length > 0 && history[0] === trimmed) return;
  history.unshift(trimmed);
  if (history.length > 5000) history.length = 5000;
}

/** 从内存历史中删除指定命令的所有重复项 */
export function removeFromHistory(shellCommand: string, command: string): void {
  const history = historyByShell.get(shellCommand);
  if (!history) return;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === command) history.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function findBestMatch(input: string, history: string[]): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  // 前缀匹配
  for (const cmd of history) {
    if (cmd !== input && cmd.toLowerCase().startsWith(lower)) return cmd;
  }
  // 参数匹配（输入出现在空格之后）
  for (const cmd of history) {
    if (cmd !== input && cmd.toLowerCase().includes(lower)) {
      const spaceIdx = cmd.indexOf(' ');
      if (spaceIdx > 0 && cmd.slice(spaceIdx + 1).toLowerCase().includes(lower)) {
        return cmd;
      }
    }
  }
  return null;
}

/** 去重：保留首次出现的版本（历史按时间倒序，所以保留最新） */
function deduplicate(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cmd of commands) {
    const lower = cmd.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(cmd);
    }
  }
  return result;
}

function findMatches(input: string, history: string[], limit = 20): string[] {
  const deduped = deduplicate(history);
  if (!input) return deduped.slice(0, limit);
  const lower = input.toLowerCase();
  const results: string[] = [];
  // 1. 前缀匹配（命令名以输入开头）
  for (const cmd of deduped) {
    if (cmd.toLowerCase().startsWith(lower)) {
      results.push(cmd);
      if (results.length >= limit) return results;
    }
  }
  // 2. 参数匹配（输入出现在空格之后，即作为参数的一部分）
  for (const cmd of deduped) {
    if (cmd.toLowerCase().startsWith(lower)) continue;
    // 只匹配空格之后出现的子串（参数级别）
    const spaceIdx = cmd.indexOf(' ');
    if (spaceIdx > 0 && cmd.slice(spaceIdx + 1).toLowerCase().includes(lower)) {
      results.push(cmd);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Prompt stripping
// ---------------------------------------------------------------------------

function stripPrompt(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';

  // PowerShell: "PS C:\path> command"
  const psMatch = trimmed.match(/^PS\s+.+?>\s*(.*)/);
  if (psMatch) return psMatch[1].trim();

  // CMD: "C:\path> command"
  const cmdMatch = trimmed.match(/^[A-Za-z]:[^>]*>\s*(.*)/) ||
                   trimmed.match(/^\\\\[^>]*>\s*(.*)/);
  if (cmdMatch) return cmdMatch[1].trim();

  // Bash/Zsh: "user@host:~/path$ command"
  const bashMatch = trimmed.match(/\$\s+(.*)/) || trimmed.match(/#\s+(.*)/);
  if (bashMatch) return bashMatch[1].trim();

  return trimmed;
}

// ---------------------------------------------------------------------------
// Suggestion state per terminal
// ---------------------------------------------------------------------------

interface SuggestState {
  activeSuggestion: string | null;
  currentInput: string;
  ghostEl: HTMLSpanElement | null;
  listEl: HTMLDivElement | null;
  historyIndex: number;
  historyMatches: string[];
  shellCommand: string;
  /** 当前选中的列表项索引（用于列表面板） */
  listSelectedIndex: number;
}

const states = new Map<number, SuggestState>();

function getState(ptyId: number): SuggestState | undefined {
  return states.get(ptyId);
}

export function initSuggest(ptyId: number, shellCommand: string): void {
  states.set(ptyId, {
    activeSuggestion: null,
    currentInput: '',
    ghostEl: null,
    listEl: null,
    historyIndex: -1,
    historyMatches: [],
    shellCommand,
    listSelectedIndex: 0,
  });
  void ensureHistoryLoaded(shellCommand);
}

export function disposeSuggest(ptyId: number): void {
  const state = states.get(ptyId);
  if (!state) return;
  removeGhostEl(state);
  removeListEl(state);
  states.delete(ptyId);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function removeGhostEl(state: SuggestState): void {
  state.ghostEl?.remove();
  state.ghostEl = null;
}

function removeListEl(state: SuggestState): void {
  state.listEl?.remove();
  state.listEl = null;
  state.listSelectedIndex = 0;
}

/** 获取单元格尺寸（CSS 像素，非 canvas 像素） */
function getCellSize(term: Terminal): { cellWidth: number; cellHeight: number } {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
  if (screen && term.cols > 0 && term.rows > 0) {
    return {
      cellWidth: screen.offsetWidth / term.cols,
      cellHeight: screen.offsetHeight / term.rows,
    };
  }
  return { cellWidth: 8, cellHeight: 16 };
}

// ---------------------------------------------------------------------------
// Ghost text (inline single suggestion)
// ---------------------------------------------------------------------------

function showGhostText(term: Terminal, state: SuggestState, suggestion: string): void {
  removeGhostEl(state);

  const suffix = suggestion.slice(state.currentInput.length);
  if (!suffix) return;

  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screen) return;

  const buffer = term.buffer.active;
  const { cellWidth, cellHeight } = getCellSize(term);

  const ghost = document.createElement('span');
  ghost.textContent = suffix;
  ghost.style.cssText = `
    position: absolute;
    left: ${buffer.cursorX * cellWidth}px;
    top: ${buffer.cursorY * cellHeight}px;
    height: ${cellHeight}px;
    line-height: ${cellHeight}px;
    color: rgba(255, 255, 255, 0.3);
    pointer-events: none;
    white-space: pre;
    z-index: 5;
    font-family: ${term.options.fontFamily || 'monospace'};
    font-size: ${term.options.fontSize || 14}px;
  `;

  screen.appendChild(ghost);
  state.ghostEl = ghost;
}

// ---------------------------------------------------------------------------
// History list panel (dropdown above terminal)
// ---------------------------------------------------------------------------

/** 删除一条历史记录并刷新列表 */
function deleteMatchFromList(ptyId: number, term: Terminal, state: SuggestState, command: string): void {
  removeFromHistory(state.shellCommand, command);
  // 从当前匹配列表中移除
  state.historyMatches = state.historyMatches.filter(c => c !== command);
  if (state.listSelectedIndex >= state.historyMatches.length) {
    state.listSelectedIndex = Math.max(0, state.historyMatches.length - 1);
  }
  if (state.historyMatches.length === 0) {
    removeListEl(state);
    removeGhostEl(state);
    state.activeSuggestion = null;
  } else {
    showHistoryList(ptyId, term, state, state.historyMatches);
  }
}

function showHistoryList(ptyId: number, term: Terminal, state: SuggestState, matches: string[]): void {
  removeListEl(state);
  removeGhostEl(state);

  if (matches.length === 0) return;

  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screen) return;

  const buffer = term.buffer.active;
  const { cellHeight } = getCellSize(term);

  // 列表面板定位在光标行上方
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: absolute;
    left: 0;
    top: ${(buffer.cursorY + 1) * cellHeight}px;
    max-height: ${Math.min(matches.length, 10) * cellHeight + 8}px;
    min-width: ${Math.max(screen.offsetWidth, 300)}px;
    max-width: ${screen.offsetWidth}px;
    overflow-y: auto;
    background: var(--bg-terminal, #0a0908);
    border: 1px solid var(--border-color, #2a2824);
    border-radius: 6px;
    z-index: 10;
    font-family: ${term.options.fontFamily || 'monospace'};
    font-size: ${term.options.fontSize || 14}px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    padding: 4px 0;
  `;

  const maxShow = Math.min(matches.length, 20);
  for (let i = 0; i < maxShow; i++) {
    const item = document.createElement('div');
    item.style.cssText = `
      padding: 2px 12px;
      padding-right: 28px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-secondary, #a09890);
      line-height: ${cellHeight}px;
      position: relative;
    `;
    item.textContent = matches[i];
    if (i === state.listSelectedIndex) {
      item.style.background = 'var(--border-color, #2a2824)';
      item.style.color = 'var(--text-primary, #d8d4cc)';
    }
    item.addEventListener('mouseenter', () => {
      state.listSelectedIndex = i;
      updateListSelection(panel, state);
    });
    item.addEventListener('click', () => {
      const selected = matches[i];
      const suffix = selected.slice(state.currentInput.length);
      removeListEl(state);
      removeGhostEl(state);
      state.activeSuggestion = null;
      state.currentInput = selected;
      state.historyIndex = -1;
      state.historyMatches = [];
      if (suffix) invoke('write_pty', { ptyId, data: suffix });
    });

    // 删除按钮
    const delBtn = document.createElement('span');
    delBtn.textContent = '×';
    delBtn.style.cssText = `
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0;
      cursor: pointer;
      color: var(--text-secondary, #a09890);
      font-size: ${Math.round(cellHeight * 0.7)}px;
      line-height: 1;
      padding: 0 2px;
    `;
    delBtn.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
    delBtn.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMatchFromList(ptyId, term, state, matches[i]);
    });
    item.appendChild(delBtn);
    item.addEventListener('mouseenter', () => { delBtn.style.opacity = '0.6'; });
    item.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });

    panel.appendChild(item);
  }

  // 滚动条样式
  const style = document.createElement('style');
  style.textContent = `
    .mt-suggest-list::-webkit-scrollbar { width: 6px; }
    .mt-suggest-list::-webkit-scrollbar-thumb { background: #585b70; border-radius: 3px; }
    .mt-suggest-list::-webkit-scrollbar-track { background: transparent; }
  `;
  panel.classList.add('mt-suggest-list');
  panel.appendChild(style);

  screen.appendChild(panel);
  state.listEl = panel;

  // 确保选中项可见
  const selectedEl = panel.children[state.listSelectedIndex] as HTMLElement | undefined;
  selectedEl?.scrollIntoView({ block: 'nearest' });
}

function updateListSelection(panel: HTMLDivElement, state: SuggestState): void {
  const children = panel.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    if (el.tagName === 'STYLE') continue;
    if (i === state.listSelectedIndex) {
      el.style.background = 'var(--border-color, #2a2824)';
      el.style.color = 'var(--text-primary, #d8d4cc)';
    } else {
      el.style.background = 'transparent';
      el.style.color = 'var(--text-secondary, #a09890)';
    }
  }
  const selectedEl = children[state.listSelectedIndex] as HTMLElement | undefined;
  selectedEl?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Core: update suggestion based on current buffer content
// ---------------------------------------------------------------------------

function updateSuggestion(ptyId: number, term: Terminal): void {
  const state = getState(ptyId);
  if (!state) return;

  const history = historyByShell.get(state.shellCommand);
  if (!history || history.length === 0) return;

  // 如果列表面板打开着，不更新 ghost text
  if (state.listEl) return;

  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const line = getCurrentLineSnapshotFromBuffer(buffer, cursorLine, buffer.cursorX);

  const input = stripPrompt(line ?? '');

  if (input !== state.currentInput) {
    state.historyIndex = -1;
    state.historyMatches = [];
  }

  state.currentInput = input;

  if (!input) {
    state.activeSuggestion = null;
    removeGhostEl(state);
    return;
  }

  const match = findBestMatch(input, history);
  state.activeSuggestion = match;

  if (match) {
    showGhostText(term, state, match);
  } else {
    removeGhostEl(state);
  }
}

// ---------------------------------------------------------------------------
// History navigation (Up/Down arrow)
// ---------------------------------------------------------------------------

function navigateHistory(ptyId: number, term: Terminal, direction: 'up' | 'down'): boolean {
  const state = getState(ptyId);
  if (!state) return false;

  const history = historyByShell.get(state.shellCommand);
  if (!history || history.length === 0) return false;

  // 首次按下时：收集匹配列表并显示面板
  if (!state.listEl) {
    state.historyMatches = findMatches(state.currentInput, history, 50);
    if (state.historyMatches.length === 0) return false;
    state.listSelectedIndex = 0;
    showHistoryList(ptyId, term, state, state.historyMatches);
    return true;
  }

  // 列表已打开：上下移动选择
  const matches = state.historyMatches;
  if (matches.length === 0) return false;

  if (direction === 'up') {
    state.listSelectedIndex = Math.max(0, state.listSelectedIndex - 1);
  } else {
    state.listSelectedIndex = Math.min(matches.length - 1, state.listSelectedIndex + 1);
  }

  const panel = state.listEl;
  updateListSelection(panel, state);

  // 更新 ghost text 为当前选中项
  state.activeSuggestion = matches[state.listSelectedIndex];
  removeGhostEl(state);
  if (state.activeSuggestion) {
    showGhostText(term, state, state.activeSuggestion);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Input interception
// ---------------------------------------------------------------------------

export function handleSuggestOnData(ptyId: number, term: Terminal, data: string): boolean {
  const state = getState(ptyId);
  if (!state) return false;

  // Right arrow: 接受建议（关闭列表）
  if (data === '\x1b[C' && state.activeSuggestion) {
    removeListEl(state);
    return false; // 让调用者发送后缀到 PTY
  }

  // Up arrow: 打开/浏览历史列表
  if (data === '\x1b[A') {
    return navigateHistory(ptyId, term, 'up');
  }

  // Down arrow: 浏览历史列表
  if (data === '\x1b[B') {
    return navigateHistory(ptyId, term, 'down');
  }

  // Enter: 如果列表打开则填充选中项（不执行），否则记录历史并发送回车
  if (data === '\r' || data === '\n' || data === '\r\n') {
    if (state.listEl) {
      const selected = state.historyMatches[state.listSelectedIndex];
      removeListEl(state);
      removeGhostEl(state);
      if (selected) {
        // 只填充后缀到终端，不发送 \r（不执行）
        const suffix = selected.slice(state.currentInput.length);
        state.activeSuggestion = null;
        state.currentInput = selected;
        state.historyIndex = -1;
        state.historyMatches = [];
        if (suffix) {
          invoke('write_pty', { ptyId, data: suffix });
        }
        return true; // 消费事件，不发送原始 \r
      }
      return false;
    }
    if (state.currentInput.trim()) {
      appendToHistory(state.shellCommand, state.currentInput);
    }
    state.activeSuggestion = null;
    state.historyIndex = -1;
    state.historyMatches = [];
    removeGhostEl(state);
    return false;
  }

  // Escape: 关闭列表 / 清除建议
  if (data === '\x1b') {
    if (state.listEl) {
      removeListEl(state);
      removeGhostEl(state);
      state.activeSuggestion = null;
      return true; // 消费 Esc，不发送到 PTY
    }
    state.activeSuggestion = null;
    state.historyIndex = -1;
    state.historyMatches = [];
    removeGhostEl(state);
    return false;
  }

  // Ctrl+C: 清除
  if (data === '\x03') {
    removeListEl(state);
    state.activeSuggestion = null;
    state.historyIndex = -1;
    state.historyMatches = [];
    removeGhostEl(state);
    return false;
  }

  // Delete 键: 删除当前高亮的历史项
  if (data === '\x1b[3~' && state.listEl) {
    const cmd = state.historyMatches[state.listSelectedIndex];
    if (cmd) deleteMatchFromList(ptyId, term, state, cmd);
    return true;
  }

  // 其他按键：延迟更新建议，等 PTY 回显处理完毕后再读 buffer
  setTimeout(() => updateSuggestion(ptyId, term), 30);
  return false;
}

export function getActiveSuggestionSuffix(ptyId: number): string | null {
  const state = getState(ptyId);
  if (!state || !state.activeSuggestion) return null;
  return state.activeSuggestion.slice(state.currentInput.length);
}

export function clearSuggestion(ptyId: number): void {
  const state = getState(ptyId);
  if (!state) return;
  state.activeSuggestion = null;
  state.historyIndex = -1;
  state.historyMatches = [];
  removeGhostEl(state);
  removeListEl(state);
}
