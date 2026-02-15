#!/usr/bin/env node

/**
 * GRAISONBOT WEBHOOK SERVER
 * 
 * Receives Twitter mentions via webhook
 * Filters for verified accounts
 * Generates AI replies (Claude Haiku)
 * Posts replies back to Twitter
 * 
 * Cost: $0.28/day (no polling, real-time)
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

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Twitter Webhook - handles mentions
 */
app.post('/webhooks/twitter', async (req, res) => {
  try {
    // Twitter sends confirmation challenge during setup
    if (req.body.crc_token) {
      console.log('🔐 CRC Challenge received');
      res.json({ response_token: `sha256=${hashCRC(req.body.crc_token)}` });
      return;
    }

    const { tweet_create_events } = req.body;

    if (!tweet_create_events || tweet_create_events.length === 0) {
      return res.sendStatus(200);
    }

    const mention = tweet_create_events[0];

    // Log incoming mention
    console.log(`\n💬 ${new Date().toISOString()}`);
    console.log(`   @${mention.user.screen_name}: "${mention.text.substring(0, 80)}..."`);

    // Filter checks
    if (!shouldReplyTo(mention)) {
      console.log(`   ⊘ Filtered out (not verified or not relevant)`);
      return res.sendStatus(200);
    }

    // Check dedup: already replied to this user in last 24h?
    if (await hasRecentReply(mention.user.id_str)) {
      console.log(`   ⊘ Already replied in last 24h`);
      return res.sendStatus(200);
    }

    // Generate reply
    console.log(`   🧠 Generating reply...`);
    const context = extractMentionContext(mention.text);
    const reply = await generateReply(mention.text, context);

    if (!reply) {
      console.log(`   ✗ Reply generation failed`);
      return res.sendStatus(200);
    }

    console.log(`   📝 Reply: "${reply.substring(0, 60)}..."`);

    // Post reply
    console.log(`   📤 Posting...`);
    const posted = await postReply(mention.id_str, reply);

    if (posted) {
      console.log(`   ✅ Posted: ${posted}`);
      await addReply(mention.user.id_str, mention.id_str, reply);
    } else {
      console.log(`   ✗ Post failed`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(`Webhook error: ${error.message}`);
    res.sendStatus(200); // Always respond 200 to Twitter
  }
});

/**
 * Generate AI reply using Claude Haiku
 */
async function generateReply(mentionText, context) {
  try {
    const systemPrompt = `You are @graisonbot, a knowledgeable AI assistant about crypto, AI agents, and blockchain.
    
Guidelines:
- Reply directly to their question/point (don't repeat it back)
- Be specific and data-driven when possible
- Keep it under 250 chars
- No emojis
- Conversational tone
- If you don't know, ask clarifying questions`;

    const userPrompt = `Reply to this mention (they mentioned @graisonbot):

"${mentionText}"

${context ? `Context: ${context}` : ''}

Your reply:`;

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

    return message.content[0].type === 'text' ? message.content[0].text.trim() : null;
  } catch (error) {
    console.error(`Claude error: ${error.message}`);
    return null;
  }
}

/**
 * Post reply to Twitter
 */
async function postReply(replyToId, text) {
  try {
    const response = await rwClient.v2.reply(text, {
      reply: {
        in_reply_to_tweet_id: replyToId,
      },
    });

    return response.data?.id || null;
  } catch (error) {
    console.error(`Twitter post error: ${error.message}`);
    return null;
  }
}

/**
 * CRC hash for Twitter webhook verification
 */
function hashCRC(crcToken) {
  const crypto = await import('crypto');
  const hmac = crypto.createHmac('sha256', process.env.TWITTER_API_SECRET);
  hmac.update(crcToken);
  return hmac.digest('base64');
}

/**
 * Get recent replies
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
        reply: r.reply_text,
        timestamp: r.timestamp
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get statistics
 */
app.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    const costPerReply = 0.014; // $0.004 (Claude) + $0.010 (Twitter)
    const dailyCost = costPerReply * (stats.total_replies / 7); // Average per day
    
    res.json({
      ...stats,
      costPerReply: `$${costPerReply.toFixed(3)}`,
      estimatedDailyAverage: `$${(dailyCost).toFixed(2)}`,
      estimatedMonthly: `$${(dailyCost * 30).toFixed(2)}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log('🚀 GRAISONBOT WEBHOOK SERVER');
  console.log('='.repeat(60));
  console.log(`Listening on port ${PORT}`);
  console.log(`Webhook URL: https://your-domain.com/webhooks/twitter`);
  console.log('');
  console.log('API Endpoints:');
  console.log(`  GET  /health              → Server status`);
  console.log(`  GET  /stats               → Usage & cost`);
  console.log(`  GET  /api/replies?hours=24 → Recent replies`);
  console.log(`  POST /webhooks/twitter    → Webhook endpoint`);
  console.log('');
  console.log('Cost per reply: $0.004 (Claude) + $0.010 (Twitter post)');
  console.log('Expected daily: ~$0.28 (20 replies/day)');
  console.log('');
});
