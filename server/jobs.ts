/**
 * Job history — SQLite, one row per take. Settings persist as JSON so any
 * take can be refired verbatim or with a nudged seed/prompt.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
const db = new Database(join(config.dataDir, 'openfield.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS takes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_id INTEGER,
  kind TEXT NOT NULL,               -- 'video' | 'still' | 'upres'
  shot_name TEXT NOT NULL,
  prompt_id TEXT,                   -- ComfyUI prompt id
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|rendering|done|failed|stopped
  settings TEXT NOT NULL,           -- JSON of all params
  output_path TEXT,
  render_seconds REAL,
  transcript TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  parent_take_id INTEGER            -- upres links back to its source take
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL,
  last_used TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS speed (
  key TEXT PRIMARY KEY,             -- model|WxH|frames bucket
  seconds_per_step REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS preambles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- what @mentions match
  kind TEXT NOT NULL DEFAULT 'character',     -- character | prop | place
  refs TEXT NOT NULL DEFAULT '[]',            -- JSON CastRef[], 1 to 6
  notes TEXT NOT NULL DEFAULT '',             -- the words a mention puts in the prompt
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS take_workflows (
  take_id INTEGER PRIMARY KEY,      -- one API-format graph per take
  graph TEXT NOT NULL,              -- JSON, loadable as-is in ComfyUI
  source TEXT NOT NULL              -- 'engine' (what ran) | 'submitted' (our copy)
);
`);

export interface Take {
  id: number;
  created_at: string;
  project_id: number | null;
  kind: string;
  shot_name: string;
  prompt_id: string | null;
  status: string;
  settings: string;
  output_path: string | null;
  render_seconds: number | null;
  transcript: string | null;
  starred: number;
  error: string | null;
  parent_take_id: number | null;
}

export const takes = {
  create(row: { project_id: number | null; kind: string; shot_name: string; settings: unknown; parent_take_id?: number }): number {
    const r = db
      .prepare('INSERT INTO takes (project_id, kind, shot_name, settings, parent_take_id) VALUES (?,?,?,?,?)')
      .run(row.project_id, row.kind, row.shot_name, JSON.stringify(row.settings), row.parent_take_id ?? null);
    return Number(r.lastInsertRowid);
  },
  /*
   * 'stopped' (cancelled, cleared, removed) is terminal: the engine often
   * reports the dead job later (as canceled, expired or even succeeded), and
   * that late result must not relabel the take or bring it back to the Library.
   */
  setPrompt(id: number, promptId: string) {
    db.prepare("UPDATE takes SET prompt_id=?, status=CASE WHEN status='stopped' THEN status ELSE 'rendering' END WHERE id=?").run(promptId, id);
  },
  finish(id: number, outputPath: string, renderSeconds?: number) {
    db.prepare("UPDATE takes SET status='done', output_path=?, render_seconds=? WHERE id=? AND status<>'stopped'").run(outputPath, renderSeconds ?? null, id);
  },
  fail(id: number, error: string, stopped = false) {
    db.prepare("UPDATE takes SET status=?, error=? WHERE id=? AND status<>'stopped'").run(stopped ? 'stopped' : 'failed', error.slice(0, 2000), id);
  },
  /** Replace a take's settings (a chained take learns its start frame late; the Director's scene cut keeps its shot list here). */
  setSettings(id: number, settings: unknown) {
    db.prepare('UPDATE takes SET settings=? WHERE id=?').run(JSON.stringify(settings), id);
  },
  /** Queued takes that never reached the engine: a chain a restart cut short. */
  orphans(): Take[] {
    return db.prepare("SELECT * FROM takes WHERE status='queued' AND prompt_id IS NULL").all() as Take[];
  },
  /** Merge fields into a take's settings JSON (measurements and outputs added after the render). */
  patchSettings(id: number, patch: Record<string, unknown>) {
    const row = db.prepare('SELECT settings FROM takes WHERE id=?').get(id) as { settings: string } | undefined;
    if (!row) return;
    db.prepare('UPDATE takes SET settings=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.settings), ...patch }), id);
  },
  setTranscript(id: number, t: string) {
    db.prepare('UPDATE takes SET transcript=? WHERE id=?').run(t, id);
  },
  star(id: number, on: boolean) {
    db.prepare('UPDATE takes SET starred=? WHERE id=?').run(on ? 1 : 0, id);
  },
  delete(id: number) {
    db.prepare('DELETE FROM takes WHERE id=?').run(id);
    db.prepare('DELETE FROM take_workflows WHERE take_id=?').run(id);
  },
  get(id: number): Take | undefined {
    return db.prepare('SELECT * FROM takes WHERE id=?').get(id) as Take | undefined;
  },
  byPrompt(promptId: string): Take | undefined {
    return db.prepare('SELECT * FROM takes WHERE prompt_id=?').get(promptId) as Take | undefined;
  },
  list(projectId: number | null, limit = 100): Take[] {
    return projectId === null
      ? (db.prepare('SELECT * FROM takes ORDER BY id DESC LIMIT ?').all(limit) as Take[])
      : (db.prepare('SELECT * FROM takes WHERE project_id=? ORDER BY id DESC LIMIT ?').all(projectId, limit) as Take[]);
  },
  active(): Take[] {
    return db.prepare("SELECT * FROM takes WHERE status IN ('queued','rendering') ORDER BY id").all() as Take[];
  },
};

/**
 * The ComfyUI graph behind each take, kept in its own table so the take list
 * stays small. Input files are named the way ComfyUI knows them, so the JSON
 * opens in ComfyUI without OpenField in the loop.
 */
export const takeWorkflows = {
  set(takeId: number, graph: Record<string, unknown>, source: 'engine' | 'submitted') {
    db.prepare(
      'INSERT INTO take_workflows (take_id, graph, source) VALUES (?,?,?) ON CONFLICT(take_id) DO UPDATE SET graph=excluded.graph, source=excluded.source'
    ).run(takeId, JSON.stringify(graph), source);
  },
  get(takeId: number): { graph: Record<string, unknown>; source: string } | undefined {
    const r = db.prepare('SELECT graph, source FROM take_workflows WHERE take_id=?').get(takeId) as any;
    return r ? { graph: JSON.parse(r.graph), source: r.source } : undefined;
  },
};

export type CastKind = 'character' | 'prop' | 'place';
/** One reference picture: the engine's input token plus our own copy on disk. */
export interface CastRef { token: string; file: string; w: number; h: number }
export interface CastMember { id: number; name: string; kind: CastKind; refs: CastRef[]; notes: string; created_at: string }

const castRow = (r: any): CastMember => ({ ...r, refs: JSON.parse(r.refs || '[]') });

/** Cast: characters, props and places, saved once and @mentioned in any prompt. */
export const cast = {
  list(): CastMember[] {
    return (db.prepare('SELECT * FROM cast ORDER BY id').all() as any[]).map(castRow);
  },
  get(id: number): CastMember | undefined {
    const r = db.prepare('SELECT * FROM cast WHERE id=?').get(id);
    return r ? castRow(r) : undefined;
  },
  byName(name: string): CastMember | undefined {
    const r = db.prepare('SELECT * FROM cast WHERE name=?').get(name);
    return r ? castRow(r) : undefined;
  },
  create(row: { name: string; kind: CastKind; refs: CastRef[]; notes: string }): number {
    const r = db.prepare('INSERT INTO cast (name, kind, refs, notes) VALUES (?,?,?,?)')
      .run(row.name, row.kind, JSON.stringify(row.refs), row.notes);
    return Number(r.lastInsertRowid);
  },
  update(id: number, patch: Partial<{ name: string; kind: CastKind; refs: CastRef[]; notes: string }>) {
    const cur = cast.get(id);
    if (!cur) return;
    db.prepare('UPDATE cast SET name=?, kind=?, refs=?, notes=? WHERE id=?').run(
      patch.name ?? cur.name, patch.kind ?? cur.kind, JSON.stringify(patch.refs ?? cur.refs), patch.notes ?? cur.notes, id,
    );
  },
  delete(id: number) {
    db.prepare('DELETE FROM cast WHERE id=?').run(id);
  },
};

export const projects = {
  list() {
    return db.prepare('SELECT * FROM projects ORDER BY last_used DESC').all();
  },
  create(name: string, folder: string): number {
    const r = db.prepare('INSERT INTO projects (name, folder) VALUES (?,?)').run(name, folder);
    return Number(r.lastInsertRowid);
  },
  touch(id: number) {
    db.prepare("UPDATE projects SET last_used=datetime('now') WHERE id=?").run(id);
  },
  get(id: number): { id: number; name: string; folder: string } | undefined {
    return db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
  },
};

export const speed = {
  get(key: string): number | undefined {
    const r = db.prepare('SELECT seconds_per_step FROM speed WHERE key=?').get(key) as any;
    return r?.seconds_per_step;
  },
  set(key: string, secondsPerStep: number) {
    db.prepare(
      'INSERT INTO speed (key, seconds_per_step) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET seconds_per_step=excluded.seconds_per_step'
    ).run(key, secondsPerStep);
  },
};

/**
 * Style preambles — text prepended to every prompt, so a house look does not
 * have to be retyped per shot.
 *
 * These ship as starting points, not as law: they are ordinary rows, editable
 * and deletable in the UI. The seed runs once and records that it ran, so a
 * preamble you delete stays deleted instead of reappearing on next boot.
 */
const SEED_PREAMBLES: { name: string; text: string }[] = [
  {
    name: 'Cel anime',
    text:
      '1990s hand-drawn cel anime, imperfect paint edges, 16mm film grain, graphite underdrawing visible, ' +
      'limited palette, no modern anime gloss, no speed lines. Held stillness with precise small motion.',
  },
  {
    name: 'Cinematic dark',
    text:
      'Cinematic, high contrast, deep blacks and negative space, luminous highlights in a dark environment, ' +
      'volumetric light, dense evolving texture, a witnessed camera that holds and breathes.',
  },
];

export interface Preamble {
  id: number;
  name: string;
  text: string;
  sort: number;
}

export const preambles = {
  list(): Preamble[] {
    return db.prepare('SELECT * FROM preambles ORDER BY sort, id').all() as Preamble[];
  },
  get(id: number): Preamble | undefined {
    return db.prepare('SELECT * FROM preambles WHERE id=?').get(id) as Preamble | undefined;
  },
  create(name: string, text: string): number {
    const sort = (db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS n FROM preambles').get() as any).n;
    const r = db.prepare('INSERT INTO preambles (name, text, sort) VALUES (?,?,?)').run(name, text, sort);
    return Number(r.lastInsertRowid);
  },
  update(id: number, patch: { name?: string; text?: string }) {
    const cur = preambles.get(id);
    if (!cur) return;
    db.prepare('UPDATE preambles SET name=?, text=? WHERE id=?')
      .run(patch.name ?? cur.name, patch.text ?? cur.text, id);
  },
  delete(id: number) {
    db.prepare('DELETE FROM preambles WHERE id=?').run(id);
  },
  /** Insert the starters exactly once in the lifetime of a database. */
  seedOnce() {
    const done = db.prepare("SELECT value FROM meta WHERE key='preambles_seeded'").get() as any;
    if (done) return;
    const insert = db.prepare('INSERT OR IGNORE INTO preambles (name, text, sort) VALUES (?,?,?)');
    SEED_PREAMBLES.forEach((p, i) => insert.run(p.name, p.text, i));
    db.prepare("INSERT INTO meta (key, value) VALUES ('preambles_seeded','1')").run();
  },
};

preambles.seedOnce();

/** Small machine-wide settings (the render size, ...), shared by every browser and the MCP server. */
export const meta = {
  get(key: string): string | undefined {
    return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  },
  set(key: string, value: string) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },
  delete(key: string) {
    db.prepare('DELETE FROM meta WHERE key=?').run(key);
  },
};
