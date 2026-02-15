#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';

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

// Persistent deduplication - load from file
const REPLIED_FILE = '/tmp/replied-mentions.json';
let repliedTo = new Set();

function loadRepliedMentions() {
  try {
    if (fs.existsSync(REPLIED_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
      repliedTo = new Set(data);
      console.log(`[INIT] Loaded ${repliedTo.size} previously-replied mentions`);
    }
  } catch (e) {
    console.error(`[INIT] Error loading replied mentions: ${e.message}`);
  }
}

function saveRepliedMentions() {
  try {
    fs.writeFileSync(REPLIED_FILE, JSON.stringify(Array.from(repliedTo)), 'utf8');
  } catch (e) {
    console.error(`[SAVE] Error saving replied mentions: ${e.message}`);
  }
}

// Load on startup
loadRepliedMentions();

app.get('/stats', (req, res) => {
  res.json({ 
    mentions_received: mentionCount, 
    replies_sent: replyCount,
    uptime_seconds: process.uptime() 
  });
});

async function poll() {
  try {
    const me = await v2Client.me();
    const response = await v2Client.get('tweets/search/recent', {
      query: `@${me.data.username} -is:retweet`,
      'tweet.fields': 'in_reply_to_user_id,public_metrics,created_at',
      max_results: 100
    });
    
    const mentions = response.data || [];
    if (mentions.length === 0) return;
    
    mentionCount = mentions.length;
    console.log(`[POLL] ${new Date().toISOString()} - Detected ${mentions.length} mentions`);
    
    // Reply to first 3 unreplied mentions
    for (const mention of mentions.slice(0, 3)) {
      // Skip if we already replied to this mention
      if (repliedTo.has(mention.id)) {
        console.log(`[SKIP] Already replied to ${mention.id}`);
        continue;
      }
      
      try {
        // Generate context-aware reply with Claude
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: `You're @graisonbot, an expert AI research bot. When someone mentions you and asks about AI research, reply with:
- Specific references to their question
- Concrete examples or data points
- Direct, conversational tone
- Max 240 characters

Always acknowledge what they said first, then provide value.`,
          messages: [{
            role: 'user',
            content: `Someone mentioned you and said: "${mention.text || ''}"\n\nWrite your reply (remember: acknowledge their point, then add specific insight):`
          }]
        });
        
        const replyText = msg.content[0].text.trim().substring(0, 280);
        
        console.log(`[MENTION] "${mention.text.substring(0, 60)}..."`);
        console.log(`[REPLY-DRAFT] "${replyText.substring(0, 60)}..."`);
        
        // Post reply via v2.tweet
        try {
          const posted = await v2Client.post('tweets', {
            text: replyText,
            reply: {
              in_reply_to_tweet_id: mention.id
            }
          });
          
          if (posted?.data?.id) {
            replyCount++;
            repliedTo.add(mention.id); // Mark as replied to
            saveRepliedMentions(); // Persist the list
            console.log(`[REPLY] ✓ Posted to ${mention.id.substring(0, 8)}... (saved)`);
          }
        } catch (postErr) {
          console.error(`[REPLY-POST-ERROR] ${postErr.message}`);
        }
      } catch (e) {
        console.error(`[REPLY-ERROR] ${e.message}`);
        console.error(`[REPLY-ERROR-DETAIL] ${JSON.stringify(e).substring(0, 200)}`);
      }
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
// Sun Feb 15 09:48:09 PST 2026
