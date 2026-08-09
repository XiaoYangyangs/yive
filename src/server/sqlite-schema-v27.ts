import type { Database } from 'better-sqlite3'

import { getBuiltinCommandPreset } from './command-preset-defaults.js'

export const applySchemaVersion27 = (db: Database) => {
  const commandPresetsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
    .get()
  if (!commandPresetsTable) return

  const codexPreset = getBuiltinCommandPreset('codex')
  if (!codexPreset) return

  db.prepare(
    `UPDATE command_presets
     SET yolo_args_template = ?, updated_at = ?
     WHERE id = ? AND is_builtin = 1`
  ).run(JSON.stringify(codexPreset.yoloArgsTemplate), Date.now(), codexPreset.id)
}
