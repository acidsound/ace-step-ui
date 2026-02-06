import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('server/ace-step.db');
console.log('Opening database at:', dbPath);

const db = new Database(dbPath);

const songId = process.argv[2];

if (songId) {
    const row = db.prepare('SELECT id, title, sentence_timestamps FROM songs WHERE id = ?').get(songId);
    console.log('Song data:', JSON.stringify(row, null, 2));
} else {
    const latest = db.prepare('SELECT id, title, created_at, length(sentence_timestamps) as st_len FROM songs ORDER BY created_at DESC LIMIT 5').all();
    console.log('Latest 5 songs:', JSON.stringify(latest, null, 2));
}

db.close();
