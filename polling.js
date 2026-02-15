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

app.get('/stats', (req, res) => {
  res.json({
    mentions_received: mentionCount,
    replies_sent: replyCount,
    uptime_seconds: process.uptime()
  });
});

async function pollForMentions() {
  try {
    console.log('[POLL] Starting poll...');
    const me = await v2Client.me();
    console.log('[POLL] Got username:', me.data.username);
    const query = `@${me.data.username} -is:retweet`;
    console.log('[POLL] Query:', query);

    let response;
    try {
      response = await v2Client.search(query);
    } catch (apiError) {
      console.error('[POLL] API Error:', apiError.message.substring(0, 100));
      return;
    }

    const tweets = response.data || [];
    console.log('[POLL] Found tweets:', tweets.length);
    
    if (tweets.length === 0) {
      console.log('[POLL] No new mentions');
      return;
    }

    if (tweets.length > 0) {
      console.log('[POLL] Processing ' + tweets.length + ' mentions');
      mentionCount += tweets.length;
      
      for (const tweet of tweets) {
        try {
          const reply = await generateReply(tweet.text);
          if (reply) {
            const posted = await postReply(tweet.id, reply);
            if (posted) {
              console.log('[POLL] Posted reply to tweet ' + tweet.id);
              replyCount++;
            }
          }
        } catch (e) {
          console.error('[POLL] Error processing tweet:', e.message);
        }
      }
      
      lastProcessedTweetId = tweets[0].id;
    }

  } catch (error) {
    console.error('[POLL ERROR]', error.message, error.stack);
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
