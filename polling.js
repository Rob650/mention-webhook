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

// Persistent tracking by AUTHOR_ID per CONVERSATION
// Key format: "conversation_id:author_id" -> reply_count (max 3)
const REPLIED_FILE = '/tmp/replied-tracking.json';
let replyTracking = {}; // { "conv_id:author_id": 1-3 }

function loadReplyTracking() {
  try {
    if (fs.existsSync(REPLIED_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
      replyTracking = data;
      console.log(`[INIT] Loaded reply tracking for ${Object.keys(replyTracking).length} author-conversation pairs`);
    }
  } catch (e) {
    console.error(`[INIT] Error loading reply tracking: ${e.message}`);
  }
}

function saveReplyTracking() {
  try {
    fs.writeFileSync(REPLIED_FILE, JSON.stringify(replyTracking), 'utf8');
  } catch (e) {
    console.error(`[SAVE] Error saving reply tracking: ${e.message}`);
  }
}

// Load on startup
loadReplyTracking();

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
      'tweet.fields': 'in_reply_to_user_id,public_metrics,created_at,conversation_id,author_id',
      max_results: 100
    });
    
    const mentions = response.data || [];
    if (mentions.length === 0) return;
    
    mentionCount = mentions.length;
    console.log(`[POLL] ${new Date().toISOString()} - Detected ${mentions.length} mentions`);
    
    // Reply to each unique author once per cycle (ONE REPLY PER AUTHOR, MAX 3 PER AUTHOR PER CONVERSATION)
    let repliedThisCycle = 0;
    const authorsSeen = new Set(); // Track who we've replied to THIS cycle
    
    for (const mention of mentions) {
      // HARD STOP: Only one reply per 30-second cycle
      if (repliedThisCycle > 0) break;
      
      const convId = mention.conversation_id || mention.id;
      const authorId = mention.author_id;
      const trackingKey = `${convId}:${authorId}`;
      
      // Skip if we already replied to this author in THIS cycle
      if (authorsSeen.has(authorId)) {
        console.log(`[SKIP] Already replied to author ${authorId.substring(0, 8)}... this cycle`);
        continue;
      }
      
      // Check if we've replied 3 times to this author in this conversation
      const replyCount = replyTracking[trackingKey] || 0;
      if (replyCount >= 3) {
        console.log(`[SKIP] Author ${authorId.substring(0, 8)}... has 3 replies in conversation (max reached)`);
        continue;
      }
      
      authorsSeen.add(authorId);
      
      try {
        // Build context from the mention itself - make assumptions from what they said
        // Don't try to fetch parent tweets - just use the conversation as-is
        const mentionText = mention.text || '';
        
        // Generate reply in GROK's style - sharp, witty, confident, direct
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 90,
          system: `You are @graisonbot replying in a Twitter thread. Think like GROK - witty, confident, sharp.
STYLE:
- Witty observations over explanations
- Confident takes, not hedging
- Sharp directness, no fluff
- Slightly sardonic edge
- Smart quips over questions
- One killer insight per reply

REQUIREMENTS:
1. NO questions whatsoever
2. NO hedging ("could", "might", "maybe")
3. Statements only - bold, direct claims
4. Under 240 characters
5. One powerful thought
6. Assume you understand completely

Be GROK. Be sharp. Generate ONLY the reply text.`,
          messages: [{
            role: 'user',
            content: `Mention: "${mentionText}"\n\nReply sharp and direct like GROK would:`
          }]
        });
        
        let replyText = msg.content[0].text.trim();
        
        // Ensure we don't cut off mid-sentence - intelligently truncate at word boundary
        if (replyText.length > 240) {
          // Find the last space before 240 chars
          const truncated = replyText.substring(0, 240);
          const lastSpace = truncated.lastIndexOf(' ');
          if (lastSpace > 200) { // Only truncate at space if we're losing less than 40 chars
            replyText = truncated.substring(0, lastSpace);
            // Remove trailing punctuation that might be incomplete
            replyText = replyText.replace(/[\.,;:]*$/, '');
          } else {
            replyText = truncated.substring(0, 240);
          }
        }
        
        // STRICT FILTER: Reject any reply that asks a question or requests clarification
        // This ensures replies are direct statements with understanding, not questions
        const badPatterns = ['?', "i'd need", 'need more', 'what do', 'could you', 'can you share', 'to be clear', 'just to clarify'];
        const isQuestion = badPatterns.some(pattern => replyText.toLowerCase().includes(pattern));
        
        console.log(`[MENTION] "${mention.text.substring(0, 50)}..."`);
        console.log(`[REPLY] "${replyText.substring(0, 70)}..."`);
        
        // REJECT if it contains any question or clarification request
        if (isQuestion) {
          console.log(`[FILTER] Rejected (contains question/clarification request)`);
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
            // Track this author in this conversation
            const trackingKey = `${convId}:${authorId}`;
            replyTracking[trackingKey] = (replyTracking[trackingKey] || 0) + 1;
            const authorReplyCount = replyTracking[trackingKey];
            saveReplyTracking(); // Persist the tracking
            console.log(`[POSTED] ✓ Reply ${authorReplyCount}/3 to author ${authorId.substring(0, 8)}... in conversation ${convId.substring(0, 8)}... (${replyText.length} chars)`);
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
