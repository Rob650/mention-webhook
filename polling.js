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
        // Fetch thread context: what is this tweet replying to?
        let threadContext = '';
        try {
          const tweetDetail = await v2Client.get(`tweets/${mention.id}`, {
            'tweet.fields': 'in_reply_to_user_id,public_metrics,created_at,conversation_id'
          });
          
          // If this is a reply, try to get what it's replying to
          if (mention.in_reply_to_user_id) {
            threadContext = `[Context: User is continuing a conversation about AI/agents/research]`;
          }
        } catch (contextErr) {
          // Silently fail
        }
        
        // Generate context-aware reply with Claude
        // Key: Don't ask clarifying questions, make informed assumptions
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: `You're @graisonbot, expert AI research analyst. Rules:
1. NEVER ask "what do you mean?" or "what are you referring to?"
2. READ between the lines - the mention text IS the context
3. Make INFORMED ASSUMPTIONS based on what they said
4. Give a DIRECT, SPECIFIC answer (not a question)
5. Reference their point explicitly
6. Max 240 characters
7. Be conversational, not robotic`,
          messages: [{
            role: 'user',
            content: `Mention: "${mention.text || ''}"\n\n${threadContext}\n\nReply with insight (NOT a question, make assumptions if needed):`
          }]
        });
        
        const replyText = msg.content[0].text.trim().substring(0, 280);
        
        console.log(`[MENTION] "${mention.text.substring(0, 50)}..."`);
        console.log(`[REPLY-DRAFT] "${replyText.substring(0, 50)}..."`);
        
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
            console.log(`[REPLY] ✓ Posted to mention ${mention.id.substring(0, 8)}... (saved)`);
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
