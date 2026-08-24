/**
 * נוכחות שקטה — the app's background life, opt-in and quiet by design.
 *
 * While enabled: closing the window hides it to the tray instead of quitting; every half
 * hour, IF the window is hidden, the tick checks whether the data has gone stale (6h+)
 * and syncs; and the runtime's pending alerts — the only three events loud enough to
 * interrupt for — become silent Windows notifications, at most three per tick, each
 * acked so it can never fire twice.
 *
 * While the window is visible the tick does nothing: the app itself is the notification.
 */

import { Menu, nativeImage, Notification, Tray } from 'electron';

const TICK_MS = 30 * 60_000;
const SYNC_STALE_MS = 6 * 3600_000;
const MAX_NOTIFICATIONS_PER_TICK = 3;

interface PendingAlertShape {
  key: string;
  titleHe: string;
  bodyHe: string;
  target: 'month' | 'future';
}

export interface PresenceDeps {
  isWindowVisible(): boolean;
  showWindow(): void;
  navigate(target: 'month' | 'future'): void;
  /** Ask the runtime to sync; resolve quietly even when it refuses (busy, offline bank…). */
  syncNow(): Promise<void>;
  /** GET/POST a runtime route; null on any failure — a background tick never throws. */
  fetchJson(route: string, init?: { method?: string; body?: string }): Promise<unknown>;
  quit(): void;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

function isAlert(value: unknown): value is PendingAlertShape {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<PendingAlertShape>;
  return typeof a.key === 'string' && typeof a.titleHe === 'string' && typeof a.bodyHe === 'string'
    && (a.target === 'month' || a.target === 'future');
}

export class QuietPresence {
  private tray: Tray | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly deps: PresenceDeps, private readonly iconPath: string) {}

  get active(): boolean {
    return this.tray !== undefined;
  }

  enable(): void {
    if (this.tray) return;
    const icon = nativeImage.createFromPath(this.iconPath);
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setToolTip('מסגרת');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'פתיחת מסגרת', click: () => this.deps.showWindow() },
      { label: 'סנכרון עכשיו', click: () => void this.deps.syncNow() },
      { type: 'separator' },
      { label: 'יציאה', click: () => this.deps.quit() },
    ]));
    this.tray.on('click', () => this.deps.showWindow());
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.deps.log.info('presence.enabled');
  }

  disable(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tray?.destroy();
    this.tray = undefined;
    this.deps.log.info('presence.disabled');
  }

  /** Exposed for a manual nudge right after enabling — the interval covers the rest. */
  async tick(): Promise<void> {
    if (this.ticking || !this.tray || this.deps.isWindowVisible()) return;
    this.ticking = true;
    try {
      const status = await this.deps.fetchJson('/api/status') as { lastSyncAt?: string | null } | null;
      if (status) {
        const last = typeof status.lastSyncAt === 'string' ? Date.parse(status.lastSyncAt) : 0;
        if (!Number.isFinite(last) || Date.now() - last > SYNC_STALE_MS) await this.deps.syncNow();
      }
      const pending = await this.deps.fetchJson('/api/alerts/pending') as { alerts?: unknown[] } | null;
      const alerts = (Array.isArray(pending?.alerts) ? pending.alerts : [])
        .filter(isAlert)
        .slice(0, MAX_NOTIFICATIONS_PER_TICK);
      if (alerts.length === 0 || !Notification.isSupported()) return;
      for (const alert of alerts) {
        const notification = new Notification({
          title: alert.titleHe,
          body: alert.bodyHe,
          icon: this.iconPath,
          silent: true, // quiet presence: presence, not noise
        });
        notification.on('click', () => {
          this.deps.showWindow();
          this.deps.navigate(alert.target);
        });
        notification.show();
      }
      // acked only AFTER showing — a failed show leaves the alert pending for the next tick
      await this.deps.fetchJson('/api/alerts/ack', {
        method: 'POST',
        body: JSON.stringify({ keys: alerts.map((a) => a.key) }),
      });
      this.deps.log.info('presence.notified', { count: alerts.length });
    } catch (error) {
      this.deps.log.warn('presence.tick-failed', { code: (error as { code?: string })?.code ?? 'UNKNOWN' });
    } finally {
      this.ticking = false;
    }
  }
}
