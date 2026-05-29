import type { PaneStatus } from '../types';

const STATUS_STYLES: Record<PaneStatus, { bg: string; shadow: string }> = {
  idle: { bg: 'var(--text-muted)', shadow: 'none' },
  'ai-idle': { bg: 'var(--color-success)', shadow: '0 0 4px var(--color-success)' },
  'ai-working': { bg: 'var(--color-ai-working)', shadow: '0 0 6px var(--color-ai-working)' },
  error: { bg: 'var(--color-error)', shadow: '0 0 4px var(--color-error)' },
};

const BLINK_STATUSES: PaneStatus[] = ['ai-working'];

export function StatusDot({ status, size = 'sm', hideIdle = false }: { status: PaneStatus; size?: 'sm' | 'md'; hideIdle?: boolean }) {
  if (hideIdle && status === 'idle') return null;
  const style = STATUS_STYLES[status];
  const anim = BLINK_STATUSES.includes(status) ? 'animate-blink' : '';
  const dim = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';

  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${dim} ${anim}`}
      style={{ backgroundColor: style.bg, boxShadow: style.shadow }}
      title={status}
    />
  );
}
