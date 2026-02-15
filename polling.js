#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import fs, { mkdirSync } from 'fs';

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
let lastMentionId = null; // Track the newest mention we've seen

// Persistent tracking by AUTHOR_ID per CONVERSATION
// CRITICAL: Use workspace directory (survives restart), not /tmp
const REPLIED_FILE = '/Users/roberttjan/.openclaw/workspace/mention-webhook/data/replied-tracking.json';
let replyTracking = {}; // { "conv_id:author_id": 1-3 }

// Also track mention IDs we've replied to (never reply to same mention twice)
const MENTIONS_FILE = '/Users/roberttjan/.openclaw/workspace/mention-webhook/data/replied-mention-ids.json';
let repliedMentions = new Set(); // Set of mention IDs we've ever replied to

// Create data directory if doesn't exist
try {
  mkdirSync('/Users/roberttjan/.openclaw/workspace/mention-webhook/data', { recursive: true });
} catch (e) {
  // Already exists
}

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

function loadRepliedMentions() {
  try {
    if (fs.existsSync(MENTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(MENTIONS_FILE, 'utf8'));
      repliedMentions = new Set(data);
      console.log(`[INIT] Loaded ${repliedMentions.size} mention IDs we've replied to`);
    }
  } catch (e) {
    console.error(`[INIT] Error loading mention IDs: ${e.message}`);
  }
}

function saveRepliedMentions() {
  try {
    fs.writeFileSync(MENTIONS_FILE, JSON.stringify(Array.from(repliedMentions)), 'utf8');
  } catch (e) {
    console.error(`[SAVE] Error saving mention IDs: ${e.message}`);
  }
}

// Load on startup
loadReplyTracking();
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
    // Only get NEW mentions (since the last one we've seen) to avoid processing old ones repeatedly
    const searchParams = {
      query: `@${me.data.username} -is:retweet`,
      'tweet.fields': 'in_reply_to_user_id,public_metrics,created_at,conversation_id,author_id',
      max_results: 100
    };
    
    // Add since_id to only get mentions newer than the last one we processed
    if (lastMentionId) {
      searchParams.since_id = lastMentionId;
    }
    
    const response = await v2Client.get('tweets/search/recent', searchParams);
    
    const mentions = response.data || [];
    
    // Update the lastMentionId to the newest mention we've seen (first in list)
    if (mentions.length > 0) {
      lastMentionId = mentions[0].id;
    }
    
    if (mentions.length === 0) return;
    
    mentionCount = mentions.length;
    console.log(`[POLL] ${new Date().toISOString()} - Detected ${mentions.length} NEW mentions (since ${lastMentionId.substring(0, 8)}...)`);
    
    // Reply to each unique mention ONCE - one reply per 30-second cycle
    let repliedThisCycle = 0;
    const mentionsSeen = new Set(); // Track MENTION IDs we've replied to THIS cycle
    
    for (const mention of mentions) {
      // HARD STOP: Only one reply per 30-second cycle
      if (repliedThisCycle > 0) break;
      
      const convId = mention.conversation_id || mention.id;
      const authorId = mention.author_id;
      const mentionId = mention.id;
      const trackingKey = `${convId}:${authorId}`;
      
      // NEVER reply to the same mention twice - check persistent list
      if (repliedMentions.has(mentionId)) {
        console.log(`[SKIP] Never replying to mention ${mentionId.substring(0, 8)}... again (already replied)`);
        continue;
      }
      
      // Skip if we already replied to THIS SPECIFIC MENTION in THIS cycle
      if (mentionsSeen.has(mentionId)) {
        console.log(`[SKIP] Already replied to this exact mention ${mentionId.substring(0, 8)}... this cycle`);
        continue;
      }
      
      // Check if we've replied 3 times to this author in this conversation
      const authorReplyCount = replyTracking[trackingKey] || 0;
      if (authorReplyCount >= 3) {
        console.log(`[SKIP] Author ${authorId.substring(0, 8)}... has 3 replies in conversation (max reached)`);
        continue;
      }
      
      mentionsSeen.add(mentionId);
      
      try {
        // Fetch the thread context to get REAL facts
        let threadContext = '';
        let researchContext = '';
        
        try {
          const tweetDetail = await v2Client.get(`tweets/${mention.id}`, {
            'tweet.fields': 'conversation_id'
          });
          
          // If this is a reply, get the full conversation thread
          if (tweetDetail.data?.conversation_id) {
            try {
              const convTweets = await v2Client.get('tweets/search/recent', {
                query: `conversation_id:${tweetDetail.data.conversation_id}`,
                'tweet.fields': 'public_metrics,created_at',
                max_results: 10
              });
              
              if (convTweets.data && convTweets.data.length > 0) {
                // Get full thread context (all tweets in conversation) - up to 5 tweets
                threadContext = convTweets.data
                  .slice(0, 5)
                  .map(t => t.text)
                  .join('\n\n---\n\n');
              }
            } catch (e) {
              // Silent fail - proceed without context
            }
          }
        } catch (contextErr) {
          // Silent fail - proceed without context
        }
        
        const mentionText = mention.text || '';
        
        // If thread context is thin, run research on the topic
        if (!threadContext || threadContext.length < 100) {
          try {
            const topicKeywords = mentionText.split(' ').slice(0, 5).join(' ');
            
            // Run Brave search for topic research
            const researchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topicKeywords)}&count=5`;
            const braveRes = await fetch(researchUrl, {
              headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY || '' }
            });
            
            if (braveRes.ok) {
              const braveData = await braveRes.json();
              if (braveData.web && braveData.web.results) {
                researchContext = braveData.web.results
                  .slice(0, 3)
                  .map(r => `${r.title}: ${r.description}`)
                  .join('\n');
              }
            }
          } catch (e) {
            // Silent fail - proceed without research
          }
        }
        
        // LOG THREAD CONTEXT FOR VERIFICATION
        console.log(`[CONTEXT-DEBUG] Tweet: "${mentionText.substring(0, 100)}..."`);
        console.log(`[CONTEXT-DEBUG] Thread context length: ${threadContext.length} chars`);
        if (threadContext.length > 0) {
          console.log(`[CONTEXT-DEBUG] Thread: ${threadContext.substring(0, 150)}...`);
        }
        if (researchContext.length > 0) {
          console.log(`[CONTEXT-DEBUG] Research: ${researchContext.substring(0, 150)}...`);
        }
        
        // Generate reply in GROK's style - witty tone + actual facts ONLY
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 90,
          system: `You are @graisonbot replying in a Twitter thread. Think like GROK - witty, confident, sharp.
CRITICAL: ZERO fabrication. ONLY facts explicitly in the thread context.

IRON RULES:
1. ONLY use facts explicitly in thread context provided
2. If claiming a company/product did something, it MUST be in the thread
3. NO invented statistics, metrics, or product claims
4. If thread is weak on facts, reference what IS there generically
5. NO hedging ("could", "might", "maybe")
6. Sharp sarcasm, confident directness
7. Under 240 characters

VERIFICATION:
- Can I point to where this fact appears in the thread? YES = use it
- Is this something I'm inferring/imagining? NO = don't use it

Example ✅: "Thread mentions X shipped Y—that's execution vs theory talk"
Example ❌: "X keeps shipping real markets" (unless explicitly in thread)

Generate ONLY the reply text.`,
          messages: [{
            role: 'user',
            content: `THREAD CONTEXT:\n${threadContext || 'EMPTY'}\n\nRESEARCH:\n${researchContext || 'NONE'}\n\nMENTION:\n${mentionText}\n\nReply using ONLY facts you can point to in the context above.`
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
            replyTracking[trackingKey] = (replyTracking[trackingKey] || 0) + 1;
            const newReplyCount = replyTracking[trackingKey];
            
            // ALSO track this specific mention so we never reply to it again
            repliedMentions.add(mentionId);
            
            // Save both tracking systems
            saveReplyTracking();
            saveRepliedMentions();
            
            console.log(`[POSTED] ✓ Reply ${newReplyCount}/3 to author ${authorId.substring(0, 8)}... in conversation ${convId.substring(0, 8)}... (${replyText.length} chars)`);
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
