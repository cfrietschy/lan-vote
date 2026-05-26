import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";

export type Db = Database.Database;

export function openDatabase(config: ServerConfig): Db {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
      created_at TEXT NOT NULL,
      ends_at TEXT,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      steam_appid INTEGER,
      cover_url TEXT NOT NULL DEFAULT '',
      store_url TEXT NOT NULL DEFAULT '',
      release_date TEXT NOT NULL DEFAULT '',
      min_players INTEGER,
      max_players INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      voter_name TEXT NOT NULL,
      option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      ranking_json TEXT NOT NULL DEFAULT '[]',
      installed_option_ids TEXT NOT NULL DEFAULT '[]',
      is_ready INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS game_pool (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      steam_appid INTEGER,
      cover_url TEXT NOT NULL DEFAULT '',
      store_url TEXT NOT NULL DEFAULT '',
      release_date TEXT NOT NULL DEFAULT '',
      min_players INTEGER,
      max_players INTEGER,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 15,
      games_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS onboarding_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT 'LAN-Startseite',
      wlan_info TEXT NOT NULL DEFAULT '',
      voice_info TEXT NOT NULL DEFAULT '',
      food_info TEXT NOT NULL DEFAULT '',
      schedule_info TEXT NOT NULL DEFAULT '',
      help_info TEXT NOT NULL DEFAULT '',
      sections_json TEXT NOT NULL DEFAULT '[]',
      category_order_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_metadata_cache (
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, external_id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      participant_polls_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_options_poll ON poll_options(poll_id, position);
    CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
    CREATE INDEX IF NOT EXISTS idx_game_pool_name ON game_pool(name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_pool_steam_appid ON game_pool(steam_appid) WHERE steam_appid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_game_metadata_cache_updated ON game_metadata_cache(updated_at);
    CREATE INDEX IF NOT EXISTS idx_poll_templates_name ON poll_templates(name COLLATE NOCASE);
  `);
  ensureColumn(db, "polls", "ends_at", "TEXT");
  ensureColumn(db, "poll_options", "steam_appid", "INTEGER");
  ensureColumn(db, "poll_options", "cover_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "poll_options", "store_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "poll_options", "release_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "poll_options", "min_players", "INTEGER");
  ensureColumn(db, "poll_options", "max_players", "INTEGER");
  ensureColumn(db, "poll_options", "tags", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "votes", "ranking_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "votes", "installed_option_ids", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "votes", "is_ready", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "game_pool", "min_players", "INTEGER");
  ensureColumn(db, "game_pool", "max_players", "INTEGER");
  ensureColumn(db, "game_pool", "release_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "game_pool", "tags", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "onboarding_settings", "sections_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "onboarding_settings", "category_order_json", "TEXT NOT NULL DEFAULT '[]'");
  db.prepare(
    `INSERT OR IGNORE INTO onboarding_settings
       (id, enabled, title, wlan_info, voice_info, food_info, schedule_info, help_info, sections_json, category_order_json, updated_at)
     VALUES (1, 0, 'LAN-Startseite', '', '', '', '', '', '[]', '[]', ?)`
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO app_settings
       (id, participant_polls_enabled, updated_at)
     VALUES (1, 0, ?)`
  ).run(new Date().toISOString());
  return db;
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
