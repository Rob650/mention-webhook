/**
 * Analytics & Monitoring
 * Track performance, costs, and engagement
 */

import fs from 'fs';
import path from 'path';

const ANALYTICS_FILE = path.join(process.cwd(), 'analytics.jsonl');

export class Analytics {
  static logMention(mention, filtered = false) {
    const record = {
      timestamp: new Date().toISOString(),
      type: 'mention',
      author: mention.user?.screen_name,
      user_id: mention.user?.id_str,
      verified: mention.user?.verified,
      followers: mention.user?.followers_count,
      text: mention.text?.substring(0, 100),
      filtered
    };
    this.write(record);
  }

  static logReply(mention, reply, tweet_id) {
    const record = {
      timestamp: new Date().toISOString(),
      type: 'reply',
      author: mention.user?.screen_name,
      mention_id: mention.id_str,
      reply_id: tweet_id,
      reply_text: reply?.substring(0, 100),
      cost: 0.014,
      success: !!tweet_id
    };
    this.write(record);
  }

  static logError(error, context = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      type: 'error',
      error: error.message,
      ...context
    };
    this.write(record);
  }

  static write(record) {
    try {
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(ANALYTICS_FILE, line);
    } catch (e) {
      console.error(`Analytics write error: ${e.message}`);
    }
  }

  static getStats(hours = 24) {
    try {
      if (!fs.existsSync(ANALYTICS_FILE)) {
        return { mentions: 0, replies: 0, errors: 0, cost: 0 };
      }

      const content = fs.readFileSync(ANALYTICS_FILE, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
      const records = lines
        .map(l => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return null;
          }
        })
        .filter(r => r && new Date(r.timestamp) > cutoff);

      const mentions = records.filter(r => r.type === 'mention' && !r.filtered).length;
      const replies = records.filter(r => r.type === 'reply' && r.success).length;
      const errors = records.filter(r => r.type === 'error').length;
      const cost = replies * 0.014;

      return {
        mentions,
        replies,
        errors,
        cost: `$${cost.toFixed(2)}`,
        period: `${hours}h`
      };
    } catch (e) {
      console.error(`Stats calculation error: ${e.message}`);
      return { mentions: 0, replies: 0, errors: 0, cost: '$0.00' };
    }
  }

  static getDailyStats() {
    return this.getStats(24);
  }

  static getWeeklyStats() {
    return this.getStats(24 * 7);
  }

  static getTopAuthors(limit = 10) {
    try {
      if (!fs.existsSync(ANALYTICS_FILE)) return [];

      const content = fs.readFileSync(ANALYTICS_FILE, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const authors = {};
      lines.forEach(line => {
        try {
          const r = JSON.parse(line);
          if (r.type === 'reply' && r.author) {
            authors[r.author] = (authors[r.author] || 0) + 1;
          }
        } catch (e) {
          // skip
        }
      });

      return Object.entries(authors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([author, count]) => ({ author, replies: count }));
    } catch (e) {
      return [];
    }
  }
}
