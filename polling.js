#!/usr/bin/env node

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

const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

const v2Client = twitterClient.v2;
const rwClient = twitterClient.readWrite;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

initDb();

const PORT = process.env.PORT || 3000;
let lastProcessedTweetId = null;
let mentionCount = 0;
let replyCount = 0;

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
      last_processed_tweet_id: lastProcessedTweetId,
      mentions_received: mentionCount,
      replies_sent: replyCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function pollForMentions() {
  try {
    logger.info('🔍 Polling for mentions...');

    const query = '@graisonbot -is:retweet';
    const params = {
      'tweet.fields': 'created_at,author_id,conversation_id',
      'user.fields': 'username,name,verified',
      'expansions': 'author_id',
      max_results: 10
    };

    if (lastProcessedTweetId) {
      params.since_id = lastProcessedTweetId;
    }

    const response = await v2Client.search(query, params);

    if (!response.data || response.data.length === 0) {
      logger.info('✓ No new mentions');
      return;
    }

    logger.info(`Found ${response.data.length} new mentions`);

    for (const tweet of response.data) {
      const author = response.includes?.users?.find(u => u.id === tweet.author_id);

      if (!author) continue;

      logger.mention(author.username, tweet.text, author.verified);
      mentionCount++;

      if (!author.verified) {
        logger.info(`Skipping unverified: @${author.username}`);
        continue;
      }

      if (await hasRecentReply(tweet.author_id)) {
        logger.warn(`Already replied to @${author.username} recently`);
        continue;
      }

      const reply = await generateReply(tweet.text);
      if (!reply) {
        logger.error('Reply generation failed');
        continue;
      }

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
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-20250514',
      max_tokens: 150,
      temperature: 0.7,
      system: `You are @graisonbot. Reply directly, specific, data-driven. Max 250 chars. No emojis.`,
      messages: [{
        role: 'user',
        content: `Tweet: "${mentionText}"\n\nReply (max 250 chars):`
      }]
    });

    const replyText = response.content[0].text.trim();
    return replyText.length > 280 ? replyText.substring(0, 275) + '...' : replyText;
  } catch (error) {
    logger.error('Reply generation failed', { error: error.message });
    return null;
  }
}

async function postReply(replyToId, text) {
  try {
    const response = await rwClient.v2.reply(text, {
      reply: { in_reply_to_tweet_id: replyToId }
    });
    return response.data?.id || null;
  } catch (error) {
    logger.error('Failed to post reply', { error: error.message });
    return null;
  }
}

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 POLLING MENTION HANDLER`);
  logger.info(`Listening on port ${PORT}`);
  logger.info('Using Twitter v2 search API');
  logger.info('');
});

await pollForMentions();
setInterval(pollForMentions, 60000);

logger.success('Polling started', { interval: '60 seconds' });

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  logger.success('Polling stopped', { total_mentions: mentionCount, total_replies: replyCount });
  process.exit(0);
});
