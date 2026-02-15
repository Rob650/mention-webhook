/**
 * Database - SQLite
 * Tracks replies to avoid duplicates within 24h
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import { logger } from './logger.js';

const dbPath = path.join(process.cwd(), 'graisonbot.db');
let db;

export function initDb() {
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      logger.error('Database connection failed', { error: err.message });
    } else {
      logger.info(`Database initialized at ${dbPath}`);
      
      // Create table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS mentions (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          tweet_id TEXT NOT NULL,
          reply_text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (tableErr) => {
        if (tableErr) {
          logger.error('Table creation failed', { error: tableErr.message });
        } else {
          // Create index AFTER table is created
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_user_id ON mentions(user_id)
          `, (indexErr) => {
            if (indexErr) logger.error('Index creation failed', { error: indexErr.message });
            else logger.info('Database ready');
          });
        }
      });
    }
  });
}

/**
 * Check if already replied to user in last 24h
 */
export async function hasRecentReply(userId) {
  return new Promise((resolve) => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    db.get(
      `SELECT id FROM mentions WHERE user_id = ? AND timestamp > ?`,
      [userId, oneDayAgo],
      (err, row) => {
        resolve(!!row);
      }
    );
  });
}

/**
 * Add reply record
 */
export async function addReply(userId, tweetId, replyText) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO mentions (user_id, tweet_id, reply_text) VALUES (?, ?, ?)`,
      [userId, tweetId, replyText],
      (err) => {
        if (err) {
          console.error('DB insert error:', err.message);
          reject(err);
        } else {
          resolve(true);
        }
      }
    );
  });
}

/**
 * Get recent replies (for analytics)
 */
export async function getRecentReplies(hours = 24) {
  return new Promise((resolve) => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    db.all(
      `SELECT * FROM mentions WHERE timestamp > ? ORDER BY timestamp DESC`,
      [since],
      (err, rows) => {
        resolve(rows || []);
      }
    );
  });
}

/**
 * Get stats
 */
export async function getStats() {
  return new Promise((resolve) => {
    db.get(
      `
      SELECT 
        COUNT(*) as total_replies,
        COUNT(DISTINCT user_id) as unique_users,
        MAX(timestamp) as last_reply
      FROM mentions
      WHERE timestamp > datetime('now', '-7 days')
      `,
      (err, row) => {
        resolve(row || { total_replies: 0, unique_users: 0 });
      }
    );
  });
}
