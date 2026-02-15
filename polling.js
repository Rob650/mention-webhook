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
    message: 'Polling-based mention handler', 
    status: 'ok'
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    mentions_received: mentionCount,
    replies_sent: replyCount
  });
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({
      total_replies: stats.total_replies,
      mentions_received: mentionCount,
      replies_sent: replyCount,
      uptime_seconds: process.uptime()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

async function pollForMentions() {
  try {
    const me = await v2Client.me();
    const query = `@${me.data.username} -is:retweet`;

    const response = await v2Client.get('tweets/search/recent', {
      query: query,
      'tweet.fields': 'created_at,author_id',
      'user.fields': 'username,name,verified',
      'expansions': 'author_id',
      max_results: 10,
      since_id: lastProcessedTweetId
    });

    const tweets = response.data || [];
    
    if (tweets.length === 0) {
      return;
    }

    for (const tweet of tweets) {
      const author = response.includes?.users?.find(u => u.id === tweet.author_id);
      if (!author) continue;

      mentionCount++;

      if (!author.verified) continue;
      if (await hasRecentReply(tweet.author_id)) continue;

      const reply = await generateReply(tweet.text);
      if (!reply) continue;

      const posted = await postReply(tweet.id, reply);
      if (posted) {
        replyCount++;
        await addReply(tweet.author_id, tweet.id, reply);
      }
    }

    if (tweets.length > 0) {
      lastProcessedTweetId = tweets[0].id;
    }

  } catch (error) {
    console.error('[POLL ERROR]', error.message);
  }
}

async function generateReply(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-20250514',
      max_tokens: 150,
      temperature: 0.7,
      system: 'Reply to this tweet. Max 250 chars. Be specific and helpful.',
      messages: [{ role: 'user', content: `Tweet: "${text}"\n\nReply:` }]
    });
    return response.content[0].text.trim().substring(0, 280);
  } catch (error) {
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
    return null;
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server listening on port', PORT);
  
  // Start polling immediately
  pollForMentions().then(() => {
    console.log('Initial poll complete');
  }).catch(err => {
    console.error('Initial poll error:', err.message);
  });

  // Then repeat every 30 seconds
  setInterval(pollForMentions, 30000);
  console.log('✅ Polling started (30 second intervals)');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
