#!/usr/bin/env node

/**
 * TWITTER FILTERED STREAM SERVER
 * 
 * Real-time mention handler using Twitter Filtered Stream API
 * 
 * Benefits:
 * - FREE (doesn't count against read limits)
 * - Real-time (instant push notifications)
 * - Event-driven (only costs when mentioned)
 * - No polling overhead
 * 
 * Setup: Run setup-stream-rules.js once to configure the filter
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

// Initialize clients
const twitterBearer = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
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
let mentionCount = 0;
let replyCount = 0;
let stream = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5 seconds

// ============================================
// API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'Real-time mention handler for @graisonbot', 
    status: 'ok',
    method: 'filtered_stream',
    latency: 'real-time'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mentions_received: mentionCount,
    replies_sent: replyCount,
    stream_connected: stream ? 'yes' : 'no'
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
      mentions_this_session: mentionCount,
      cost_per_reply: `$${costPerReply.toFixed(3)}`,
      estimated_daily_average: `$${dailyCost.toFixed(2)}`,
      estimated_monthly: `$${(dailyCost * 30).toFixed(2)}`,
      uptime_seconds: process.uptime(),
      method: 'filtered_stream',
      stream_status: stream ? 'connected' : 'disconnected'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STREAM LISTENER
// ============================================

async function handleMention(tweetData, authorData) {
  try {
    logger.mention(
      authorData.username,
      tweetData.text,
      true // All mentions come through the stream
    );

    mentionCount++;

    // FILTER: Already replied in last 24h?
    if (await hasRecentReply(tweetData.author_id)) {
      logger.warn(`Already replied to @${authorData.username} recently`);
      return;
    }

    // FILTER: Daily limit (20 replies/day to control costs)
    if (replyCount >= 20) {
      logger.warn('Daily reply limit reached (20/day)');
      return;
    }

    // Generate reply
    const reply = await generateReply(tweetData.text);
    if (!reply) {
      logger.error('Reply generation failed');
      return;
    }

    // Post reply
    const posted = await postReply(tweetData.id, reply);
    if (posted) {
      replyCount++;
      await addReply(tweetData.author_id, tweetData.id, reply);
      logger.success('Reply posted', {
        tweet_id: posted,
        author: authorData.username,
        cost: '$0.014'
      });
    }

  } catch (error) {
    logger.error('Mention handler error', { error: error.message });
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

async function startTwitterStream() {
  try {
    logger.info('📡 Connecting to Twitter Filtered Stream...');

    stream = await twitterBearer.v2.searchStream({
      'tweet.fields': ['created_at', 'author_id', 'conversation_id'],
      'user.fields': ['username', 'name', 'verified'],
      'expansions': ['author_id']
    });

    logger.success('✅ Connected to Filtered Stream');
    logger.info('Listening for @graisonbot mentions in real-time...');
    reconnectAttempts = 0; // Reset on successful connection

    // Handle incoming tweets
    stream.on('data', async (tweet) => {
      try {
        const author = tweet.includes?.users?.find(u => u.id === tweet.data.author_id);
        
        if (author) {
          await handleMention(tweet.data, author);
        }
      } catch (error) {
        logger.error('Failed to process stream tweet', { error: error.message });
      }
    });

    // Handle stream errors
    stream.on('error', (error) => {
      logger.error('Stream error', { error: error.message });

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        logger.info(`Reconnecting in ${RECONNECT_DELAY}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(startTwitterStream, RECONNECT_DELAY);
      } else {
        logger.error('Max reconnect attempts reached. Manual restart required.');
      }
    });

    // Handle stream end
    stream.on('end', () => {
      logger.warn('Stream connection ended');
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(startTwitterStream, RECONNECT_DELAY);
      }
    });

  } catch (error) {
    logger.error('Failed to start stream', { error: error.message });

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      logger.info(`Retrying in ${RECONNECT_DELAY}ms...`);
      setTimeout(startTwitterStream, RECONNECT_DELAY);
    }
  }
}

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 TWITTER FILTERED STREAM SERVER`);
  logger.info(`Listening on port ${PORT}`);
  logger.info('');
  logger.info('Configuration:');
  logger.info(`  Filter: @graisonbot -is:retweet`);
  logger.info(`  Method: Filtered Stream (real-time)`);
  logger.info(`  Latency: <1 second`);
  logger.info(`  Cost: FREE (event-driven)`);
  logger.info('');
  logger.info('Cost per reply: $0.004 (Claude) + $0.010 (Twitter)');
  logger.info('Expected daily: ~$0.28 (20 replies/day)');
  logger.info('');
  logger.info('API Endpoints:');
  logger.info(`  GET  /health`);
  logger.info(`  GET  /stats`);
  logger.info('');

  // Start the stream
  startTwitterStream();
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  if (stream) {
    stream.destroy();
  }
  logger.success('Stream stopped', {
    total_mentions: mentionCount,
    total_replies: replyCount
  });
  process.exit(0);
});
