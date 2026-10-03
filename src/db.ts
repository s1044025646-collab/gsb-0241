/** SQLite 存储（node:sqlite 内置模块）：输入摘要、产物定位与操作报告。 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export interface Db { db: DatabaseSync; dataDir: string; }

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'outputs'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'huffman.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_id INTEGER NOT NULL REFERENCES inputs(id),
      path TEXT NOT NULL,
      orig_size INTEGER NOT NULL,
      payload_bits INTEGER NOT NULL,
      header_bytes INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      ratio REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      input_id INTEGER,
      artifact_id INTEGER,
      ok INTEGER NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { db, dataDir };
}

export function recordOp(db: DatabaseSync, kind: string, ok: boolean, message: string,
  inputId: number | null = null, artifactId: number | null = null): void {
  db.prepare('INSERT INTO ops(kind,input_id,artifact_id,ok,message) VALUES(?,?,?,?,?)')
    .run(kind, inputId, artifactId, ok ? 1 : 0, message);
}
