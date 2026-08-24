import { Menu, dialog, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { DesktopCommand } from './contracts.js';

interface MenuActions {
  command(command: DesktopCommand): void;
  exportCsv(): Promise<void>;
  createBackup(): Promise<void>;
  quit(): void;
  zoom(delta: number | 'reset'): void;
  checkForUpdates(): Promise<void>;
  revealData(): Promise<void>;
  revealLogs(): Promise<void>;
  appInfo: { name: string; version: string; buildId: string };
}
export function installApplicationMenu(window: BrowserWindow, actions: MenuActions): void {
  const run = (operation: () => Promise<void>): void => {
    void operation().catch(() => {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'הפעולה לא הושלמה',
        message: 'לא הצלחנו להשלים את הפעולה כרגע.',
        buttons: ['אישור'],
      });
    });
  };

  const fileItems: MenuItemConstructorOptions[] = [
    { label: 'סנכרון עכשיו', accelerator: 'F6', click: () => actions.command('sync') },
    { label: 'רענון נתונים', accelerator: 'F5', registerAccelerator: false, click: () => actions.command('refresh') },
    { type: 'separator' },
    { label: 'ייצוא CSV…', accelerator: 'CmdOrCtrl+Shift+E', click: () => run(actions.exportCsv) },
    { label: 'יצירת גיבוי', accelerator: 'CmdOrCtrl+Shift+B', click: () => run(actions.createBackup) },
    { type: 'separator' },
    process.platform === 'darwin'
      ? { label: 'סגירת חלון', accelerator: 'Cmd+W', role: 'close' }
      : { label: 'יציאה', accelerator: 'Alt+F4', click: actions.quit },
  ];

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'קובץ',
      submenu: fileItems,
    },
    {
      label: 'תצוגה',
      submenu: [
        { label: 'איך אני החודש?', accelerator: 'CmdOrCtrl+1', click: () => actions.command('navigate-month') },
        { label: 'איך אני בכללי?', accelerator: 'CmdOrCtrl+2', click: () => actions.command('navigate-overview') },
        { label: 'ומה לגבי העתיד?', accelerator: 'CmdOrCtrl+3', click: () => actions.command('navigate-future') },
        { label: 'בריאות', accelerator: 'CmdOrCtrl+4', click: () => actions.command('navigate-health') },
        { label: 'שווי נקי', accelerator: 'CmdOrCtrl+5', click: () => actions.command('navigate-networth') },
        { label: 'חיבורים', accelerator: 'CmdOrCtrl+6', click: () => actions.command('navigate-connections') },
        { label: 'הגדרות', accelerator: 'CmdOrCtrl+,', click: () => actions.command('navigate-settings') },
        { type: 'separator' },
        { label: 'הגדלה', accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => actions.zoom(0.1) },
        { label: 'הקטנה', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => actions.zoom(-0.1) },
        { label: 'איפוס זום', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => actions.zoom('reset') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'מסך מלא' },
      ],
    },
    {
      label: 'עזרה',
      submenu: [
        { label: 'בדיקת עדכונים', click: () => run(actions.checkForUpdates) },
        { type: 'separator' },
        { label: 'פתיחת תיקיית הנתונים', click: () => run(actions.revealData) },
        { label: 'פתיחת תיקיית האבחון', click: () => run(actions.revealLogs) },
        { type: 'separator' },
        {
          label: 'אודות מסגרת',
          click: () => {
            void dialog.showMessageBox(window, {
              type: 'info',
              title: `אודות ${actions.appInfo.name}`,
              message: `${actions.appInfo.name} ${actions.appInfo.version}`,
              detail: `Build ${actions.appInfo.buildId}\nהנתונים נשמרים מקומית במחשב זה.`,
              buttons: ['אישור'],
            });
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: actions.appInfo.name,
      submenu: [
        { role: 'about', label: `אודות ${actions.appInfo.name}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'יציאה', accelerator: 'Cmd+Q', click: actions.quit },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform !== 'darwin') {
    window.setAutoHideMenuBar(true);
    window.setMenuBarVisibility(false);
  }
}
