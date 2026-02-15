#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import fs, { mkdirSync } from 'fs';
import { buildContextKnowledge } from './src/stages/stage2-full-research.js';
import { loadConversationMemory, getConversationContext, saveReplyToMemory, isFollowUp, getFollowUpContext } from './src/stages/stage2-conversation-memory.js';

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
loadConversationMemory();

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
        const mentionText = mention.text || '';
        
        // FULL RESEARCH PIPELINE
        console.log(`\n[RESEARCH-START] Processing mention: "${mentionText.substring(0, 80)}..."`);
        
        let contextKnowledge = null;
        try {
          const tweetDetail = await v2Client.get(`tweets/${mention.id}`, {
            'tweet.fields': 'conversation_id'
          });
          
          // Get full conversation thread
          if (tweetDetail.data?.conversation_id) {
            try {
              const convTweets = await v2Client.get('tweets/search/recent', {
                query: `conversation_id:${tweetDetail.data.conversation_id}`,
                'tweet.fields': 'public_metrics,created_at',
                'expansions': 'author_id',
                'user.fields': 'username',
                max_results: 20
              });
              
              if (convTweets.data && convTweets.data.length > 0) {
                console.log(`[RESEARCH] Found ${convTweets.data.length} tweets in conversation`);
                
                // Build full context knowledge
                contextKnowledge = await buildContextKnowledge(convTweets.data);
                
                console.log(`[RESEARCH] Identified ${contextKnowledge.topics.length} topics`);
                console.log(`[RESEARCH] Researched ${contextKnowledge.research.length} topics in depth`);
              }
            } catch (e) {
              console.log(`[RESEARCH-WARN] Failed to fetch full thread: ${e.message}`);
            }
          }
        } catch (contextErr) {
          console.log(`[RESEARCH-WARN] Failed to get conversation ID: ${contextErr.message}`);
        }
        
        // Fallback if no research happened
        if (!contextKnowledge) {
          contextKnowledge = {
            conversationSummary: mentionText,
            topics: [],
            research: [],
            threadLength: 1
          };
        }
        
        console.log(`[RESEARCH-COMPLETE] Ready to compose reply with full context`);
        
        // Build comprehensive research context for AI
        let researchContextStr = '';
        if (contextKnowledge.research && contextKnowledge.research.length > 0) {
          researchContextStr = contextKnowledge.research
            .map(r => {
              const summary = r.research.substring(0, 300); // Limit per project
              return `PROJECT: ${r.topic}\n${summary}`;
            })
            .join('\n\n---\n\n');
        }
        
        // Log what we're about to pass to AI
        const projectsWithData = contextKnowledge.research.filter(r => r.sources > 0).length;
        // Check if this is a follow-up to a previous reply
        const followUpContext = isFollowUp(authorId, convId) ? getFollowUpContext(authorId, convId) : null;
        if (followUpContext) {
          console.log(`[FOLLOW-UP] Author ${authorId.substring(0, 8)}... asking follow-up to: "${followUpContext.previousReply.substring(0, 50)}..."`);
          console.log(`[FOLLOW-UP] New question: "${mentionText.substring(0, 50)}..."`);
        }
        
        console.log(`[COMPOSE] Building reply with ${contextKnowledge.research.length} projects researched (${projectsWithData} with data)`);
        
        // Generate reply in GROK's style - ALWAYS make an attempt
        // Special handling for follow-ups: evolve the conversation, don't repeat
        const systemPrompt = followUpContext 
          ? `You are @graisonbot replying in a Twitter thread. This is a FOLLOW-UP to your previous reply.
INSTRUCTION: They're asking a new question/challenge. Don't repeat your last answer. Evolve the conversation.

CONTEXT:
- Your last reply was: "${followUpContext.previousReply}"
- They're now asking: "${mentionText}"

YOUR JOB:
1. Address their NEW question directly
2. Build on your previous point, don't repeat it
3. Answer specifically (if they ask "which project", name one)
4. Still witty, confident, sharp
5. STATEMENT ONLY (no questions)
6. Under 240 characters

Example:
- LAST: "Multi-stream beats single tokens"
- FOLLOW-UP: "Which project though?"
- REPLY: "Bittensor—subnets force genuine utility, not hype"

Generate ONLY the reply text.`
          : `You are @graisonbot replying in a Twitter thread. Think like GROK - witty, confident, sharp.
INSTRUCTION: You ALWAYS reply. Never silent. Keep it aligned with the thread discussion.

YOUR JOB:
1. Address the topic being discussed in the thread
2. Make an informed comment (use research if available)
3. Be witty and confident
4. STATEMENT ONLY - no questions, no hedging
5. Align with what people are talking about
6. Under 240 characters

CRITICAL RULES:
- ALWAYS attempt a reply
- Base on thread context
- Use research findings when available
- Confident tone (GROK style)
- Pure statement (no "?", no hedging)

Generate ONLY the reply text.`;
        
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 90,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: followUpContext
              ? `PREVIOUS CONTEXT:\nYour last reply: "${followUpContext.previousReply}"\nTheir follow-up: "${mentionText}"\nThread: ${contextKnowledge.conversationSummary.substring(0, 300)}\n\nAnswer their follow-up, don't repeat yourself.`
              : `THREAD DISCUSSION:\n${contextKnowledge.conversationSummary}\n\nPROJECTS MENTIONED:\n${contextKnowledge.projects.map(p => `@${p.name}`).join(', ') || 'general discussion'}\n\nRESEARCH:\n${researchContextStr || '(thread context)'}\n\nUSER COMMENT:\n${mentionText}\n\nMake a confident statement.`
          }]
        });
        
        let replyText = msg.content[0].text.trim();
        
        // ALWAYS have a fallback - never reply with nothing
        if (!replyText || replyText.length === 0) {
          // Multi-level fallback
          if (contextKnowledge.projects && contextKnowledge.projects.length > 0) {
            const names = contextKnowledge.projects.slice(0, 2).map(p => `@${p.name}`).join(' vs ');
            replyText = `${names}—execution always wins the debate.`;
          } else if (contextKnowledge.conversationSummary.length > 0) {
            // Extract theme from conversation
            if (contextKnowledge.conversationSummary.toLowerCase().includes('agent')) {
              replyText = 'Agents shipping > agents theorizing. Clear pattern.';
            } else if (contextKnowledge.conversationSummary.toLowerCase().includes('token')) {
              replyText = 'Token incentives actually work when builders execute on them.';
            } else {
              replyText = 'Building beats talking every single time. Prove me wrong.';
            }
          } else {
            replyText = 'Execution wins. Always.';
          }
        }
        
        // Ensure we don't cut off mid-sentence - intelligently truncate at word boundary
        if (replyText.length > 240) {
          // Find the last space before 240 chars
          const truncated = replyText.substring(0, 240);
          const lastSpace = truncated.lastIndexOf(' ');
          if (lastSpace > 200) { // Only truncate at space if we're losing less than 40 chars
            replyText = truncated.substring(0, lastSpace);
            // Add ellipsis if truncated mid-thought
            if (!replyText.endsWith('.') && !replyText.endsWith('!')) {
              replyText += '.';
            }
          } else {
            replyText = truncated.substring(0, 237) + '...';
          }
        }
        
        // Final validation: ensure it's a statement (no trailing questions)
        if (replyText.includes('?')) {
          replyText = replyText.replace(/\?$/g, '.').replace(/\s+\?$/g, '.');
        }
        
        console.log(`[MENTION] "${mention.text.substring(0, 50)}..."`);
        console.log(`[REPLY] "${replyText.substring(0, 70)}..."`);
        
        // Ensure no question marks remain (convert to statements)
        replyText = replyText.replace(/\?/g, '.');
        
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
            
            // Save conversation memory (for follow-up detection)
            saveReplyToMemory(authorId, convId, replyText, mentionText);
            
            // Save all tracking systems
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
