import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface InputRow {
  id: number;
  sha256: string;
  size_bytes: number;
  source_type: string;
  source_path: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: number;
  input_id: number;
  path: string;
  file_size: number;
  payload_bits: number;
  header_bytes: number;
  pad_bits: number;
  symbol_count: number;
  input_sha256: string;
  created_at: string;
}

export interface OperationRow {
  id: number;
  op: string;
  status: string;
  input_id: number | null;
  artifact_id: number | null;
  detail: string;
  error_code: string | null;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        input_id INTEGER NOT NULL REFERENCES inputs(id),
        path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        payload_bits INTEGER NOT NULL,
        header_bytes INTEGER NOT NULL,
        pad_bits INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        input_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok','error')),
        input_id INTEGER REFERENCES inputs(id),
        artifact_id INTEGER REFERENCES artifacts(id),
        detail TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  upsertInput(sha256: string, size: number, sourceType: string, sourcePath: string | null): number {
    const existing = this.db
      .prepare('SELECT id FROM inputs WHERE sha256 = ?')
      .get(sha256) as { id: number } | undefined;
    if (existing) return existing.id;
    const res = this.db
      .prepare('INSERT INTO inputs (sha256, size_bytes, source_type, source_path) VALUES (?, ?, ?, ?)')
      .run(sha256, size, sourceType, sourcePath);
    return Number(res.lastInsertRowid);
  }

  getInput(id: number): InputRow | undefined {
    return this.db.prepare('SELECT * FROM inputs WHERE id = ?').get(id) as InputRow | undefined;
  }

  listInputs(limit = 50): InputRow[] {
    return this.db.prepare('SELECT * FROM inputs ORDER BY id DESC LIMIT ?').all(limit) as unknown as InputRow[];
  }

  insertArtifact(a: Omit<ArtifactRow, 'id' | 'created_at'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO artifacts (input_id, path, file_size, payload_bits, header_bytes, pad_bits, symbol_count, input_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.input_id,
        a.path,
        a.file_size,
        a.payload_bits,
        a.header_bytes,
        a.pad_bits,
        a.symbol_count,
        a.input_sha256,
      );
    return Number(res.lastInsertRowid);
  }

  getArtifact(id: number): ArtifactRow | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  }

  listArtifacts(limit = 50): ArtifactRow[] {
    return this.db.prepare('SELECT * FROM artifacts ORDER BY id DESC LIMIT ?').all(limit) as unknown as ArtifactRow[];
  }

  logOperation(o: {
    op: string;
    status: 'ok' | 'error';
    inputId?: number | null;
    artifactId?: number | null;
    detail: string;
    errorCode?: string | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO operations (op, status, input_id, artifact_id, detail, error_code)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(o.op, o.status, o.inputId ?? null, o.artifactId ?? null, o.detail, o.errorCode ?? null);
    return Number(res.lastInsertRowid);
  }

  listOperations(limit = 50): OperationRow[] {
    return this.db.prepare('SELECT * FROM operations ORDER BY id DESC LIMIT ?').all(limit) as unknown as OperationRow[];
  }

  close(): void {
    this.db.close();
  }
}
