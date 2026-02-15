#!/usr/bin/env node

/**
 * POLLING-BASED MENTION HANDLER
 * 
 * Instead of waiting for Twitter webhooks (enterprise only),
 * we poll for mentions every 60 seconds.
 * 
 * Cost: Free tier Twitter API v2 (500k tweets/month limit)
 * Delay: ~60 seconds (vs instant with webhooks)
 * Reliability: 100% (no webhook registration issues)
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import { initDb, hasRecentReply, addReply, getStats } from './src/db.js';
import { logger } from './src/logger.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Twitter & Anthropic
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

const rwClient = twitterClient.readWrite;
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize database
initDb();

const PORT = process.env.PORT || 3000;
let lastProcessedTweetId = null;
let mentionCount = 0;
let replyCount = 0;

// ============================================
// API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'Polling-based mention handler for @graisonbot', 
    status: 'ok',
    method: 'polling',
    interval: '60 seconds'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mentions_received: mentionCount,
    replies_sent: replyCount,
    last_processed_tweet_id: lastProcessedTweetId
  });
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    const costPerReply = 0.014;
    const dailyCost = costPerReply * (stats.total_replies / 7 || 1);

    res.json({
      total_replies: stats.total_replies,
      unique_users: stats.unique_users,
      last_reply: stats.last_reply,
      cost_per_reply: `$${costPerReply.toFixed(3)}`,
      estimated_daily_average: `$${dailyCost.toFixed(2)}`,
      estimated_monthly: `$${(dailyCost * 30).toFixed(2)}`,
      uptime_seconds: process.uptime(),
      polling_interval_seconds: 60,
      last_processed_tweet_id: lastProcessedTweetId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POLLING LOGIC
// ============================================

async function pollForMentions() {
  try {
    logger.info('🔍 Polling for new mentions...');

    const query = '@graisonbot -is:retweet';
    const params = {
      'tweet.fields': 'created_at,author_id,conversation_id',
      'user.fields': 'username,name,verified',
      'expansions': 'author_id',
      max_results: 10
    };

    // Only fetch tweets after last processed one
    if (lastProcessedTweetId) {
      params.since_id = lastProcessedTweetId;
    }

    const response = await rwClient.v2.search(query, params);

    if (!response.data || response.data.length === 0) {
      logger.info('✓ No new mentions');
      return;
    }

    logger.info(`Found ${response.data.length} new mentions`);

    // Process each mention
    for (const tweet of response.data) {
      const author = response.includes?.users?.find(u => u.id === tweet.author_id);

      logger.mention(
        author.username,
        tweet.text,
        author.verified
      );

      mentionCount++;

      // FILTER: Verified accounts only
      if (!author.verified) {
        logger.info(`Skipping unverified author: @${author.username}`);
        continue;
      }

      // FILTER: Already replied in last 24h?
      if (await hasRecentReply(tweet.author_id)) {
        logger.warn(`Already replied to @${author.username} recently`);
        continue;
      }

      // Generate reply
      const reply = await generateReply(tweet.text);
      if (!reply) {
        logger.error('Reply generation failed');
        continue;
      }

      // Post reply
      const posted = await postReply(tweet.id, reply);
      if (posted) {
        replyCount++;
        await addReply(tweet.author_id, tweet.id, reply);
        logger.success('Reply posted', {
          tweet_id: posted,
          author: author.username,
          cost: '$0.014'
        });
      }
    }

    // Update last processed ID
    if (response.meta.newest_id) {
      lastProcessedTweetId = response.meta.newest_id;
      logger.info(`Updated last_processed_tweet_id: ${lastProcessedTweetId}`);
    }

  } catch (error) {
    logger.error('Polling error', { error: error.message });
  }
}

async function generateReply(mentionText) {
  try {
    const systemPrompt = `You are @graisonbot, a knowledgeable AI about crypto, AI agents, and blockchain.

Guidelines:
- Reply directly to their point (don't repeat)
- Specific and data-driven
- Under 250 chars (Twitter limit ~280)
- No emojis, no hashtags
- Conversational and helpful`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-20250514',
      max_tokens: 150,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Tweet: "${mentionText}"\n\nReply (max 250 chars):`
      }]
    });

    const replyText = response.content[0].text.trim();
    
    // Verify it's under 280 chars
    if (replyText.length > 280) {
      logger.warn('Reply too long, truncating', { length: replyText.length });
      return replyText.substring(0, 275) + '...';
    }

    return replyText;
  } catch (error) {
    logger.error('Reply generation failed', { error: error.message });
    return null;
  }
}

async function postReply(replyToId, text) {
  try {
    const response = await rwClient.v2.reply(text, {
      reply: {
        in_reply_to_tweet_id: replyToId,
      },
    });

    return response.data?.id || null;
  } catch (error) {
    logger.error('Failed to post reply', { error: error.message });
    return null;
  }
}

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 POLLING-BASED MENTION HANDLER`);
  logger.info(`Listening on port ${PORT}`);
  logger.info('');
  logger.info('Configuration:');
  logger.info(`  Query: @graisonbot -is:retweet`);
  logger.info(`  Interval: 60 seconds`);
  logger.info(`  Filter: Verified accounts only`);
  logger.info(`  Dedup: 24h window per user`);
  logger.info('');
  logger.info('Cost per reply: $0.004 (Claude) + $0.010 (Twitter)');
  logger.info('Expected daily: ~$0.28 (20 replies/day)');
  logger.info('');
  logger.info('API Endpoints:');
  logger.info(`  GET  /health`);
  logger.info(`  GET  /stats`);
  logger.info('');
});

// Start polling immediately
await pollForMentions();

// Then poll every 60 seconds
setInterval(pollForMentions, 60000);

logger.success('Polling started', { interval: '60 seconds' });

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  logger.success('Polling stopped', {
    total_mentions: mentionCount,
    total_replies: replyCount
  });
  process.exit(0);
});
