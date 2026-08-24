import { app, autoUpdater, type BrowserWindow } from 'electron';
import type { UpdateState } from './contracts.js';
import type { RedactedLogger } from './logger.js';

type StateListener = (state: UpdateState) => void;

function releaseVersion(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/^v/i, '').slice(0, 80) : undefined;
}

export class DesktopUpdater {
  private stateValue: UpdateState = { status: 'disabled' };
  private readonly feedUrl: string | undefined;
  private configured = false;
  private listener: StateListener | undefined;

  constructor(private readonly logger: RedactedLogger, candidate?: string) {
    // Electron autoUpdater is Windows/macOS only. Unsigned community macOS builds and Linux
    // packages are updated manually from GitHub Releases.
    if (process.platform !== 'win32') return;
    if (!candidate) return;
    try {
      const url = new URL(candidate);
      if (url.username || url.password) throw new Error('Update feed credentials may not be embedded in the URL.');
      const allowDevelopmentHttp = !app.isPackaged && process.env.MISGERET_ALLOW_INSECURE_UPDATE_FEED === '1';
      if (url.protocol !== 'https:' && !(allowDevelopmentHttp && url.protocol === 'http:')) {
        throw new Error('Update feed must use HTTPS.');
      }
      this.feedUrl = url.toString();
      this.stateValue = app.isPackaged ? { status: 'idle' } : { status: 'disabled' };
    } catch (error) {
      this.logger.error('updater.invalid-feed', error);
    }
  }

  get state(): UpdateState {
    return { ...this.stateValue };
  }

  get updateReady(): boolean {
    return this.stateValue.status === 'downloaded';
  }

  configure(window: BrowserWindow, listener: StateListener): void {
    this.listener = listener;
    if (this.configured || !this.feedUrl || !app.isPackaged) {
      this.publish(this.stateValue);
      return;
    }
    this.configured = true;
    autoUpdater.setFeedURL({ url: this.feedUrl });

    autoUpdater.on('checking-for-update', () => this.publish({ status: 'checking' }));
    autoUpdater.on('update-available', () => {
      this.publish({ status: 'available' });
      setTimeout(() => {
        if (this.stateValue.status === 'available') this.publish({ status: 'downloading' });
      }, 250);
    });
    autoUpdater.on('update-not-available', () => this.publish({ status: 'not-available' }));
    autoUpdater.on('update-downloaded', (_event, _notes, name) => {
      this.publish({ status: 'downloaded', version: releaseVersion(name) });
    });
    autoUpdater.on('error', (error) => {
      this.logger.error('updater.error', error);
      this.publish({ status: 'error', message: 'לא ניתן לבדוק עדכונים כרגע' });
    });

    window.on('closed', () => {
      this.listener = undefined;
    });
  }

  scheduleInitialCheck(): void {
    if (!this.feedUrl || !app.isPackaged) return;
    const firstRun = process.argv.includes('--squirrel-firstrun');
    setTimeout(() => void this.check(), firstRun ? 15_000 : 5_000);
    // Long-running sessions still learn about new releases: re-check every hour
    // until an update has been downloaded (after that, only the update button matters).
    const interval = setInterval(() => {
      if (this.stateValue.status !== 'downloaded') void this.check();
    }, 60 * 60 * 1000);
    interval.unref();
  }

  async check(): Promise<UpdateState> {
    if (!this.feedUrl || !app.isPackaged) return this.state;
    // 'downloaded' stays sticky: a re-check must not hide the ready-to-restart button.
    if (['checking', 'available', 'downloading', 'downloaded'].includes(this.stateValue.status)) return this.state;
    try {
      this.publish({ status: 'checking' });
      autoUpdater.checkForUpdates();
    } catch (error) {
      this.logger.error('updater.check-failed', error);
      this.publish({ status: 'error', message: 'לא ניתן לבדוק עדכונים כרגע' });
    }
    return this.state;
  }

  quitAndInstall(): void {
    if (!this.updateReady) throw new Error('UPDATE_NOT_READY');
    autoUpdater.quitAndInstall();
  }

  private publish(state: UpdateState): void {
    this.stateValue = state;
    this.listener?.({ ...state });
  }
}
