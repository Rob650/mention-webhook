#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import fs, { mkdirSync } from 'fs';
import { buildContextKnowledge } from './src/stages/stage2-full-research.js';
import { loadConversationMemory, getConversationContext, saveReplyToMemory, isFollowUp, getFollowUpContext } from './src/stages/stage2-conversation-memory.js';
import { findThreadOrigin, analyzeThreadEvolution, buildContextFromOrigin } from './src/stages/stage1-thread-origin.js';
import { extractTickers, extractProjectMentions, researchTickerProject, analyzeSentiment } from './src/stages/stage3-ticker-context.js';

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

let lastErrorTime = 0;
let errorCount = 0;

async function poll() {
  try {
    // Rate limit backoff - if we've hit errors, wait before retrying
    const timeSinceLastError = Date.now() - lastErrorTime;
    if (errorCount > 3 && timeSinceLastError < 60000) {
      console.log(`[RATE-LIMIT] Backing off... (${Math.round((60000 - timeSinceLastError) / 1000)}s remaining)`);
      return;
    }
    if (timeSinceLastError > 60000) {
      errorCount = 0;
    }
    
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
        let threadOriginContext = null;
        
        try {
          const tweetDetail = await v2Client.get(`tweets/${mention.id}`, {
            'tweet.fields': 'conversation_id'
          });
          
          // Get conversation ID
          if (tweetDetail.data?.conversation_id) {
            try {
              // STAGE 1: Find thread origin (understand what this thread is ABOUT)
              console.log(`[THREAD-ORIGIN] Finding root of conversation ${tweetDetail.data.conversation_id.substring(0, 8)}...`);
              const threadData = await findThreadOrigin(tweetDetail.data.conversation_id, v2Client);
              
              if (threadData) {
                threadOriginContext = analyzeThreadEvolution(threadData);
                console.log(`[THREAD-ORIGIN] ✓ Original topic: "${threadOriginContext.originalTopic.substring(0, 60)}..."`);
                console.log(`[THREAD-ORIGIN] ✓ Thread length: ${threadOriginContext.threadLength} tweets`);
                
                // Use the full thread data for context
                const convTweets = threadData.allTweets;
                
                if (convTweets && convTweets.length > 0) {
                  console.log(`[RESEARCH] Analyzing full thread (${convTweets.length} tweets total)`);
                  
                  // Build full context knowledge (including research on topics)
                  contextKnowledge = await buildContextKnowledge(convTweets, v2Client);
                  
                  console.log(`[RESEARCH] Identified ${contextKnowledge.topics.length} topics`);
                  console.log(`[RESEARCH] Researched ${contextKnowledge.research.length} topics in depth`);
                }
              }
            } catch (e) {
              console.log(`[THREAD-ORIGIN-WARN] Failed to analyze thread: ${e.message}`);
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
            projects: [],
            research: [],
            threadLength: 1
          };
        }
        
        // STAGE 3: Extract and research specific tickers/projects
        let tickerContext = '';
        try {
          const fullThreadText = contextKnowledge.conversationSummary;
          const tickers = extractTickers(fullThreadText);
          
          if (tickers.length > 0) {
            console.log(`[TICKER-EXTRACT] Found ${tickers.length} tickers: ${tickers.join(', ')}`);
            
            // Research each ticker
            const tickerData = [];
            for (const ticker of tickers.slice(0, 3)) {
              const research = await researchTickerProject(ticker, v2Client);
              if (research) {
                tickerData.push(research);
                console.log(`[TICKER-RESEARCH] ✓ ${ticker}: ${research.sentiment} sentiment (${research.tweets} tweets)`);
              }
              await new Promise(r => setTimeout(r, 300)); // Rate limit
            }
            
            if (tickerData.length > 0) {
              tickerContext = tickerData
                .map(t => `${t.ticker}: ${t.sentiment.toUpperCase()} (${t.tweets} mentions)\nContext: ${t.context.substring(0, 200)}`)
                .join('\n\n---\n\n');
            }
          }
        } catch (e) {
          console.log(`[TICKER-EXTRACT] Error: ${e.message}`);
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
        console.log(`[RESEARCH-SUMMARY] Found data on ${projectsWithData}/${contextKnowledge.research.length} topics`);
        if (contextKnowledge.research.length > 0) {
          contextKnowledge.research.slice(0, 3).forEach(r => {
            console.log(`  - ${r.topic}: ${r.sources} sources, "${r.research.substring(0, 50)}..."`);
          });
        }
        // Check if this is a follow-up to a previous reply
        const followUpContext = isFollowUp(authorId, convId) ? getFollowUpContext(authorId, convId) : null;
        if (followUpContext) {
          console.log(`[FOLLOW-UP] Author ${authorId.substring(0, 8)}... asking follow-up to: "${followUpContext.previousReply.substring(0, 50)}..."`);
          console.log(`[FOLLOW-UP] New question: "${mentionText.substring(0, 50)}..."`);
        }
        
        // Log thread origin context
        if (threadOriginContext && threadOriginContext.originalTopic) {
          console.log(`[CONTEXT] Thread started: "${threadOriginContext.originalTopic.substring(0, 60)}..."`);
          console.log(`[CONTEXT] Core topic: ${threadOriginContext.coreMessage}`);
          console.log(`[CONTEXT] We're at position ${threadOriginContext.threadLength} in conversation`);
        } else {
          console.log(`[CONTEXT] Thread origin not determined, using conversation context`);
        }
        
        console.log(`[COMPOSE] Building reply with ${contextKnowledge.research.length} projects researched (${projectsWithData} with data)`);
        
        // Generate reply in GROK's style - TOPIC-FOCUSED, PROJECT-SPECIFIC, not random commentary
        // UNDERSTAND thread origin + current position + specific projects/tickers
        const systemPrompt = followUpContext 
          ? `You are @graisonbot replying in a Twitter thread. This is a FOLLOW-UP to your previous reply.

CRITICAL: THE ORIGINAL POST IS ABOUT: ${threadOriginContext?.coreMessage || 'unknown'}

Your reply MUST be related to that topic. Don't go off on tangents.

THREAD CONTEXT:
${threadOriginContext?.originalTopic ? `- Original topic: "${threadOriginContext.originalTopic.substring(0, 80)}..."` : ''}
- Your last reply: "${followUpContext?.previousReply || ''}"
- They're now asking: "${mentionText}"

PROJECT/TICKER CONTEXT:
${tickerContext ? tickerContext.substring(0, 300) : 'No specific ticker'}

INSTRUCTION: Answer their follow-up while staying ON TOPIC about ${threadOriginContext?.coreMessage || 'the thread topic'}.

YOUR JOB:
1. Address their question directly
2. Build on your previous point, don't repeat it
3. STAY ON TOPIC - reply should be about ${threadOriginContext?.coreMessage || 'the original topic'}, not something else
4. Still witty, confident, sharp
5. STATEMENT ONLY (no questions)
6. Under 240 characters

Generate ONLY the reply text.`
          : `You are @graisonbot replying in a Twitter thread. Think like GROK - witty, confident, sharp.

CRITICAL - UNDERSTAND WHAT THIS POST IS ACTUALLY ABOUT:
Core Topic: ${threadOriginContext?.coreMessage || 'General discussion'}
Original: "${threadOriginContext?.originalTopic.substring(0, 100) || 'N/A'}..."

YOUR REPLY MUST BE RELATED TO THIS TOPIC. Don't reply with something unrelated.

PROJECT/TICKER CONTEXT:
${tickerContext ? tickerContext.substring(0, 500) : 'No specific ticker mentioned'}

INSTRUCTION: Make a comment that is DIRECTLY RELATED to the original post's topic.
- If it's about a product launch → comment on the launch, not something else
- If it's about fundraising → comment on the fundraising, not price action
- If it's about appreciation/gratitude → comment on that, not cynical takes
- If there's a ticker → comment on that project in context of the original topic

YOUR JOB:
1. Understand what the ORIGINAL post is about (see above)
2. Make sure your reply is RELATED to that topic
3. If ticker/project mentioned: be specific, not generic
4. Be witty and confident
5. STATEMENT ONLY - no questions
6. Under 240 characters

CRITICAL: DON'T MAKE OFF-TOPIC REPLIES. Stay focused on what the original post is actually saying.

Generate ONLY the reply text.`;
        
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 90,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: followUpContext
              ? `ORIGINAL POST IS ABOUT: ${threadOriginContext?.coreMessage || 'general'}\nTHREAD: "${threadOriginContext?.originalTopic?.substring(0, 80) || 'general'}"\nLAST REPLY: "${followUpContext.previousReply}"\nFOLLOW-UP: "${mentionText}"\n\nTICKERS: ${tickerContext?.substring(0, 200) || 'None'}\n\nAnswer the follow-up WHILE STAYING ON TOPIC about ${threadOriginContext?.coreMessage || 'the original topic'}. Don't repeat. Make it relevant to what the post is actually about.`
              : `ORIGINAL POST IS ABOUT: ${threadOriginContext?.coreMessage || 'general discussion'}\nTHREAD: "${threadOriginContext?.originalTopic?.substring(0, 100) || 'general'}"\n\nCONVERSATION:\n${contextKnowledge.conversationSummary?.substring(0, 300) || ''}\n\nTICKERS/PROJECTS:\n${tickerContext || (contextKnowledge.projects && contextKnowledge.projects.length > 0 ? contextKnowledge.projects.map(p => `@${p.name}`).join(', ') : 'None')}\n\nQUESTION: ${mentionText}\n\nMake a reply that is RELATED to the original topic (${threadOriginContext?.coreMessage || 'the post'}). Don't go off on random tangents. If a ticker is mentioned, comment on it in context of the original topic.`
          }]
        });
        
        let replyText = '';
        try {
          replyText = msg.content && msg.content[0] && msg.content[0].text 
            ? msg.content[0].text.trim() 
            : '';
        } catch (e) {
          console.log(`[REPLY-PARSE] Error extracting reply text: ${e.message}`);
          replyText = '';
        }
        
        // ALWAYS have a fallback - analyze tickers for momentum/attention
        if (!replyText || replyText.length === 0) {
          // If we have ticker context, analyze the momentum
          if (tickerContext && tickerContext.length > 0) {
            // Extract ticker from context
            const tickerMatch = tickerContext.match(/\$[A-Z]+/);
            const ticker = tickerMatch ? tickerMatch[0] : null;
            
            if (ticker) {
              // Analyze attention/momentum from research
              const hasBullish = tickerContext.toLowerCase().includes('ship') || tickerContext.toLowerCase().includes('launch') || tickerContext.toLowerCase().includes('execution');
              const hasGrowth = tickerContext.toLowerCase().includes('grow') || tickerContext.toLowerCase().includes('uptick') || tickerContext.toLowerCase().includes('trending');
              
              if (hasBullish) {
                replyText = `${ticker} shipping real execution—attention follows builders, not hype. That's the pattern.`;
              } else if (hasGrowth) {
                replyText = `${ticker} attention curve is classic: early builders, then momentum awareness. Execution drives the narrative.`;
              } else {
                replyText = `${ticker} gaining traction because execution beats speculation. People see the signal.`;
              }
            }
          }
          
          // If still no reply, use context-based fallback
          if (!replyText || replyText.length === 0) {
            const threadSummary = contextKnowledge.conversationSummary.toLowerCase();
            const hasBots = threadSummary.includes('bot') || threadSummary.includes('agent');
            const hasBuilding = threadSummary.includes('build') || threadSummary.includes('ship');
            
            if (hasBots) {
              replyText = 'Autonomous systems are shipping—that\'s where the real signal lives.';
            } else if (hasBuilding) {
              replyText = 'Execution always wins the attention battle. Builders know.';
            } else {
              replyText = 'Attention flows to execution. Always has.';
            }
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
        console.log(`[PIPELINE-COMPLETE] ✓ Read thread (${contextKnowledge.threadLength} tweets) → Research (${contextKnowledge.research.length} topics) → Reply`);
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
    const isRateLimit = error.message && (error.message.includes('429') || error.message.includes('rate limit'));
    if (isRateLimit) {
      errorCount++;
      lastErrorTime = Date.now();
      console.error(`[RATE-LIMIT] Hit limit. Error #${errorCount}. Backing off...`);
    } else {
      console.error(`[ERROR] ${new Date().toISOString()} - ${error.message}`);
    }
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
