#!/usr/bin/env node

/**
 * GRAISONBOT WEBHOOK SERVER v2
 * 
 * Production-ready webhook handler for Twitter mentions
 * 
 * Cycle:
 *   Twitter → Webhook POST → Filter → Claude → Reply → Twitter
 *   Cost: $0.014 per reply ($0.004 Claude + $0.010 Twitter post)
 *   Time: ~5 seconds per reply
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import { initDb, hasRecentReply, addReply, getRecentReplies, getStats } from './src/db.js';
import { shouldReplyTo, extractMentionContext } from './src/filters.js';
import { logger } from './src/logger.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize clients
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

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mentions_received: mentionCount,
    replies_sent: replyCount
  });
});

/**
 * Statistics endpoint
 */
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
      estimated_yearly: `$${(dailyCost * 365).toFixed(2)}`,
      uptime_seconds: process.uptime()
    });
  } catch (error) {
    logger.error('Stats fetch failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Recent replies endpoint
 */
app.get('/api/replies', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours || '24');
    const replies = await getRecentReplies(hours);

    res.json({
      count: replies.length,
      hours,
      replies: replies.map(r => ({
        user_id: r.user_id,
        tweet_id: r.tweet_id,
        reply: r.reply_text.substring(0, 100),
        timestamp: r.timestamp
      }))
    });
  } catch (error) {
    logger.error('Replies fetch failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Twitter Webhook - handles mentions
 * Triggered by Twitter when someone mentions @graisonbot
 */
app.post('/webhooks/twitter', async (req, res) => {
  try {
    // Twitter sends confirmation challenge during setup
    if (req.body.crc_token) {
      logger.info('Received CRC challenge');
      const responseToken = generateCRCToken(req.body.crc_token);
      res.json({ response_token: responseToken });
      return;
    }

    const { tweet_create_events } = req.body;

    if (!tweet_create_events || tweet_create_events.length === 0) {
      return res.sendStatus(200);
    }

    const mention = tweet_create_events[0];
    mentionCount++;

    // Log the mention
    logger.mention(
      mention.user.screen_name,
      mention.text,
      mention.user.verified
    );

    // FILTER 1: Check if we should reply
    if (!shouldReplyTo(mention)) {
      logger.info('Mention filtered out', {
        reason: mention.user.verified ? 'not @graisonbot' : 'not verified'
      });
      return res.sendStatus(200);
    }

    // FILTER 2: Deduplication - already replied in last 24h?
    if (await hasRecentReply(mention.user.id_str)) {
      logger.warn('Duplicate author', {
        author: mention.user.screen_name,
        user_id: mention.user.id_str
      });
      return res.sendStatus(200);
    }

    // GENERATE REPLY
    logger.info('Generating reply with Claude Haiku');
    const context = extractMentionContext(mention.text);
    const reply = await generateReply(mention.text, context);

    if (!reply) {
      logger.error('Reply generation returned null');
      return res.sendStatus(200);
    }

    logger.reply(mention.user.screen_name, reply);

    // POST REPLY
    logger.info('Posting reply to Twitter');
    const posted = await postReply(mention.id_str, reply);

    if (posted) {
      replyCount++;
      await addReply(mention.user.id_str, mention.id_str, reply);
      logger.success('Reply posted', {
        tweet_id: posted,
        author: mention.user.screen_name,
        cost: '$0.014'
      });
    } else {
      logger.error('Failed to post reply');
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Webhook error', { error: error.message });
    res.sendStatus(200); // Always respond 200 to Twitter
  }
});

/**
 * Generate AI reply using Claude Haiku
 * Cost: $0.004 per reply (50 tokens avg)
 */
async function generateReply(mentionText, context) {
  try {
    const systemPrompt = `You are @graisonbot, a knowledgeable AI about crypto, AI agents, and blockchain.

Guidelines:
- Reply directly to their point (don't repeat)
- Specific and data-driven
- Under 250 chars (Twitter limit ~280)
- No emojis, no hashtags
- Conversational and helpful
- Ask clarifying questions if confused`;

    const userPrompt = `Mention from someone: "${mentionText}"

${context ? `Topic context: ${context}` : ''}

Your reply (direct answer, no fluff):`;

    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const text = message.content[0]?.text || null;
    if (text) {
      logger.cost('Claude Haiku', 0.004);
    }
    return text;
  } catch (error) {
    logger.error('Claude generation failed', { error: error.message });
    return null;
  }
}

/**
 * Post reply to Twitter
 * Cost: $0.010 per post
 */
async function postReply(replyToId, text) {
  try {
    const response = await rwClient.v2.reply(text, {
      reply: {
        in_reply_to_tweet_id: replyToId,
      },
    });

    if (response.data?.id) {
      logger.cost('Twitter POST', 0.010);
      return response.data.id;
    }

    return null;
  } catch (error) {
    logger.error('Twitter post failed', { error: error.message });
    return null;
  }
}

/**
 * Generate CRC token for Twitter webhook verification
 */
function generateCRCToken(crcToken) {
  try {
    const hmac = crypto.createHmac('sha256', process.env.TWITTER_API_SECRET);
    hmac.update(crcToken);
    return `sha256=${hmac.digest('base64')}`;
  } catch (error) {
    logger.error('CRC generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Start server
 */
app.listen(PORT, () => {
  logger.info(`🚀 GRAISONBOT WEBHOOK SERVER v2`);
  logger.info(`Listening on port ${PORT}`);
  logger.info(`Webhook URL: ${process.env.WEBHOOK_URL || 'https://your-domain.com/webhooks/twitter'}`);
  logger.info('');
  logger.info('API Endpoints:');
  logger.info(`  GET  /health`);
  logger.info(`  GET  /stats`);
  logger.info(`  GET  /api/replies?hours=24`);
  logger.info(`  POST /webhooks/twitter`);
  logger.info('');
  logger.info('Cost per reply: $0.004 (Claude) + $0.010 (Twitter)');
  logger.info('Expected daily: ~$0.28 (20 replies/day)');
  logger.info('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  logger.success('Server stopped', {
    total_mentions: mentionCount,
    total_replies: replyCount
  });
  process.exit(0);
});
