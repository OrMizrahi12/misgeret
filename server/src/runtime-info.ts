export const API_SCHEMA_VERSION = 1;

export interface RuntimeInfo {
  appVersion: string;
  buildId: string;
  apiSchemaVersion: number;
  /** The active profile's schema at boot. Every profile is reconciled to it as it is opened. */
  dbSchemaVersion: number;
  /** The profile the runtime opened at boot — the registry's activeId. */
  activeProfileId: string;
  initialization: 'ready';
}
