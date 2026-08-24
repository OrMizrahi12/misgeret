import { desktop } from './desktop';

export type Theme = 'light' | 'dark';

/** index.html boots the theme before first paint; this module owns changes after that. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem('misgeret-theme', theme);
  } catch {
    // storage unavailable — the choice simply won't survive a restart
  }
  // window chrome (caption buttons, background) follows the renderer theme
  void desktop?.setTheme?.(theme).catch(() => undefined);
  window.dispatchEvent(new CustomEvent<Theme>('misgeret:theme', { detail: theme }));
}

/** Keeps every theme control (header toggle, Settings pills) on the same page. */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<Theme>).detail);
  window.addEventListener('misgeret:theme', handler);
  return () => window.removeEventListener('misgeret:theme', handler);
}

/** Align the desktop window chrome with the booted theme (call once on startup). */
export function syncDesktopTheme(): void {
  void desktop?.setTheme?.(currentTheme()).catch(() => undefined);
}
