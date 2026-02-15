#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';

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

const PORT = process.env.PORT || 3000;
let mentionCount = 0;
let replyCount = 0;

app.get('/', (req, res) => {
  res.json({ status: 'ok', mentions_received: mentionCount, replies_sent: replyCount });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stats', (req, res) => {
  res.json({ mentions_received: mentionCount, replies_sent: replyCount, uptime_seconds: process.uptime() });
});

async function poll() {
  try {
    const me = await v2Client.me();
    const query = `@${me.data.username} -is:retweet`;

    const response = await v2Client.search(query);
    const mentions = response.data || [];

    console.log(`[${new Date().toISOString()}] Found ${mentions.length} mentions`);

    if (mentions.length > 0) {
      mentionCount += mentions.length;
      
      for (const mention of mentions.slice(0, 3)) {
        try {
          const reply = await anthropic.messages.create({
            model: 'claude-haiku-4-20250514',
            max_tokens: 150,
            messages: [{ role: 'user', content: `Reply to: ${mention.text.substring(0, 100)}\n\nYour reply (max 250 chars):` }]
          });

          const replyText = reply.content[0].text.trim().substring(0, 280);

          const posted = await rwClient.v2.reply(replyText, {
            reply: { in_reply_to_tweet_id: mention.id }
          });

          if (posted.data?.id) {
            replyCount++;
            console.log(`[${new Date().toISOString()}] Replied to ${mention.id}`);
          }
        } catch (e) {
          console.error(`[${new Date().toISOString()}] Error replying: ${e.message}`);
        }
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Poll error: ${error.message}`);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Server listening on port ${PORT}`);
  
  // Start polling
  poll();
  setInterval(poll, 30000);
  console.log(`[${new Date().toISOString()}] Polling started (every 30s)`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
