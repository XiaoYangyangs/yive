import type { Database } from 'better-sqlite3'

import { type AppStateRecord, type AppStateValue, createAppStateStore } from './app-state-store.js'

export interface SettingsStore {
  getAppState: (key: string) => AppStateRecord | undefined
  setAppState: (key: string, value: AppStateValue) => void
}

export type { AppStateRecord, AppStateValue }

export const createSettingsStore = (db: Database): SettingsStore => {
  const appStateStore = createAppStateStore(db)

  return {
    getAppState: appStateStore.get,
    setAppState: appStateStore.set,
  }
}
