import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS pets (
      id TEXT PRIMARY KEY,
      join_code TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','member')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_devices_pet ON devices(pet_id, created_at);

    -- Append-only action log. UNIQUE(pet_id, action_id) is the idempotency guard.
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      version INTEGER NOT NULL,
      changed INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (pet_id, action_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  `);

  const q = (sql) => db.prepare(sql);
  const stmts = {
    insertPet: q('INSERT INTO pets (id, join_code, version, state, created_at) VALUES (?, ?, 1, ?, ?)'),
    petById: q('SELECT * FROM pets WHERE id = ?'),
    petByCode: q('SELECT * FROM pets WHERE join_code = ?'),
    updatePet: q('UPDATE pets SET version = ?, state = ? WHERE id = ?'),
    deletePet: q('DELETE FROM pets WHERE id = ?'),
    insertDevice: q('INSERT INTO devices (id, pet_id, token_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    deviceByHash: q('SELECT * FROM devices WHERE token_hash = ?'),
    devicesOfPet: q('SELECT id, name, role FROM devices WHERE pet_id = ? ORDER BY created_at, id'),
    deleteDevice: q('DELETE FROM devices WHERE id = ?'),
    promote: q("UPDATE devices SET role = 'owner' WHERE id = ?"),
    eventByAction: q('SELECT 1 FROM events WHERE pet_id = ? AND action_id = ?'),
    insertEvent: q(
      'INSERT INTO events (pet_id, device_id, action_id, type, payload, version, changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    deleteEventsOfPet: q('DELETE FROM events WHERE pet_id = ?'),
    pruneEvents: q('DELETE FROM events WHERE created_at < ?'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  return { db, stmts, tx };
}
