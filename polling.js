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

// Persistent deduplication by MENTION ID (one reply per mention, period)
const REPLIED_FILE = '/tmp/replied-mentions.json';
let repliedMentions = new Set();

function loadRepliedMentions() {
  try {
    if (fs.existsSync(REPLIED_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
      repliedMentions = new Set(data);
      console.log(`[INIT] Loaded ${repliedMentions.size} previously-replied mentions`);
    }
  } catch (e) {
    console.error(`[INIT] Error loading replied mentions: ${e.message}`);
  }
}

function saveRepliedMentions() {
  try {
    fs.writeFileSync(REPLIED_FILE, JSON.stringify(Array.from(repliedMentions)), 'utf8');
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
      'tweet.fields': 'in_reply_to_user_id,public_metrics,created_at,conversation_id',
      max_results: 100
    });
    
    const mentions = response.data || [];
    if (mentions.length === 0) return;
    
    mentionCount = mentions.length;
    console.log(`[POLL] ${new Date().toISOString()} - Detected ${mentions.length} mentions`);
    
    // Reply to first unreplied mention (max 1 per cycle to avoid spam)
    let repliedThisCycle = 0;
    
    for (const mention of mentions) {
      if (repliedThisCycle > 0) break; // Only one reply per cycle
      
      // Skip if we've already replied to THIS SPECIFIC MENTION
      if (repliedMentions.has(mention.id)) {
        console.log(`[SKIP] Already replied to mention ${mention.id.substring(0, 8)}...`);
        continue;
      }
      
      try {
        // Build context from the mention itself - make assumptions from what they said
        // Don't try to fetch parent tweets - just use the conversation as-is
        const mentionText = mention.text || '';
        
        // Generate assumption-based reply with Claude
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: `You are @graisonbot. Someone mentioned you in a Twitter thread and said something.
Your response MUST:
1. NOT ask any questions
2. NOT say "I need context" or "what do you mean?"
3. NOT say "I'd need more info" or "just to be clear"
4. Make a direct statement or answer
5. Assume you understand what they're asking
6. Be conversational and natural
7. Be under 240 characters
DO NOT generate a question. Generate a statement or answer.`,
          messages: [{
            role: 'user',
            content: `Generate a reply to: "${mentionText}"\n\nONLY generate a statement or answer, never a question or request for clarification.`
          }]
        });
        
        const replyText = msg.content[0].text.trim().substring(0, 280);
        
        // Filter out replies that ask questions or ask for context
        const badPatterns = ['?', "i'd need", 'need more', 'what do', 'could you', 'can you share', 'to be clear', 'just to clarify'];
        const isQuestion = badPatterns.some(pattern => replyText.toLowerCase().includes(pattern));
        
        console.log(`[MENTION] "${mention.text.substring(0, 50)}..."`);
        console.log(`[REPLY-DRAFT] "${replyText.substring(0, 50)}..."`);
        
        // Only post if it doesn't ask a question
        if (isQuestion) {
          console.log(`[SKIP-Q] Filtered out question reply`);
          continue;
        }
        
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
            repliedThisCycle++;
            repliedMentions.add(mention.id); // Mark THIS mention as replied to
            saveRepliedMentions(); // Persist the list
            console.log(`[REPLY] ✓ Posted to mention ${mention.id.substring(0, 8)}...`);
          }
        } catch (postErr) {
          console.error(`[REPLY-POST-ERROR] ${postErr.message}`);
        }
      } catch (e) {
        console.error(`[REPLY-ERROR] ${e.message}`);
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
