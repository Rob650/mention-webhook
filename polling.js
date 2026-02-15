#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';

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

const PORT = process.env.PORT || 3000;
let mentionCount = 0;

app.get('/stats', (req, res) => {
  res.json({ mentions_received: mentionCount, uptime_seconds: process.uptime() });
});

async function poll() {
  try {
    const me = await v2Client.me();
    const response = await v2Client.get('tweets/search/recent', {
      query: `@${me.data.username} -is:retweet`,
      max_results: 100
    });
    
    const mentions = response.data || [];
    if (mentions.length > 0) {
      mentionCount = mentions.length;
      console.log(`[POLL] ${new Date().toISOString()} - Detected ${mentions.length} mentions`);
    }
  } catch (error) {
    console.error(`[ERROR] ${new Date().toISOString()} - ${error.message}`);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[START] Listening on port ${PORT} at ${new Date().toISOString()}`);
  
  // Poll immediately
  poll().then(() => {
    console.log(`[INIT] Initial poll complete`);
    // Then every 30 seconds
    setInterval(poll, 30000);
  });
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
