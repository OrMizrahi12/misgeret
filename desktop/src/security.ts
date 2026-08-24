import type { BrowserWindow, Session } from 'electron';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
].join('; ');

export class DesktopSecurity {
  private runtimeOrigin: string | undefined;
  private apiToken: string | undefined;
  private window: BrowserWindow | undefined;

  constructor(private readonly session: Session) {
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.setDevicePermissionHandler(() => false);

    session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if ([
          'authorization',
          'x-misgeret-token',
          'x-misgeret-desktop-action',
        ].includes(name.toLowerCase())) delete headers[name];
      }

      if (
        this.runtimeOrigin
        && this.apiToken
        && details.url.startsWith(`${this.runtimeOrigin}/api/`)
        && details.webContentsId === this.window?.webContents.id
      ) {
        headers.Authorization = `Bearer ${this.apiToken}`;
      }
      callback({ requestHeaders: headers });
    });

    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!this.runtimeOrigin || !details.url.startsWith(`${this.runtimeOrigin}/`)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
      );
      headers['Content-Security-Policy'] = [CSP];
      headers['X-Content-Type-Options'] = ['nosniff'];
      headers['Referrer-Policy'] = ['no-referrer'];
      callback({ responseHeaders: headers });
    });
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedDocument(url)) event.preventDefault();
    });
  }

  setRuntime(origin: string, apiToken: string): void {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('UNSAFE_RUNTIME_ORIGIN');
    this.runtimeOrigin = parsed.origin;
    this.apiToken = apiToken;
  }

  isTrustedSender(url: string): boolean {
    return this.isAllowedDocument(url);
  }

  private isAllowedDocument(url: string): boolean {
    if (this.runtimeOrigin && (url === this.runtimeOrigin || url.startsWith(`${this.runtimeOrigin}/`))) return true;
    try {
      const parsed = new URL(url);
      // the recovery screen ships inside desktop/dist/static (see desktop/build.mjs)
      return parsed.protocol === 'file:' && parsed.pathname.endsWith('/desktop/dist/static/recovery.html');
    } catch {
      return false;
    }
  }
}
