#!/usr/bin/env node

/**
 * FULL RESEARCH STAGE
 * 1. Get full conversation thread
 * 2. Identify topics/projects
 * 3. Deep research on each
 * 4. Understand context
 * 5. Build knowledge base for reply
 */

import { TwitterApi } from 'twitter-api-v2';
import { Anthropic } from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const v2Client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN).readOnlyClient;
const anthropic = new Anthropic({ 
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function fetchFullConversation(conversationId, maxTweets = 20) {
  try {
    const tweets = await v2Client.get('tweets/search/recent', {
      query: `conversation_id:${conversationId}`,
      'tweet.fields': 'public_metrics,created_at,author_id',
      'expansions': 'author_id',
      'user.fields': 'username,verified',
      max_results: maxTweets
    });
    
    return tweets.data || [];
  } catch (e) {
    console.error(`[ERROR] Failed to fetch conversation: ${e.message}`);
    return [];
  }
}

async function identifyTopics(conversationThread) {
  if (!conversationThread || conversationThread.length === 0) return [];
  
  // Simple keyword extraction - no AI needed
  const threadText = conversationThread
    .map(t => t.text)
    .join(' ');
  
  // Find @mentions and capitalized words (likely project/company names)
  const mentions = threadText.match(/@[\w]+/g) || [];
  const capitalized = threadText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) || [];
  
  // Extract unique topics
  const topics = new Map();
  
  // Add mentions as companies/projects
  mentions.forEach(m => {
    const name = m.substring(1);
    topics.set(name, { name, type: 'project', mentions: (threadText.match(new RegExp(m, 'g')) || []).length });
  });
  
  // Add capitalized terms (concepts/technologies)
  capitalized.forEach(term => {
    if (topics.size < 8 && term.length > 3) {
      if (!topics.has(term)) {
        topics.set(term, { name: term, type: 'concept', mentions: (threadText.match(new RegExp(term, 'g')) || []).length });
      }
    }
  });
  
  return Array.from(topics.values()).slice(0, 10);
}

async function deepResearchTopic(topic, v2Client) {
  try {
    const topicName = topic.name.replace('@', '');
    const research = [];
    let sources = 0;
    
    // LAYER 1: Brave web search
    try {
      const braveKey = process.env.BRAVE_API_KEY;
      if (braveKey) {
        console.log(`[BRAVE-SEARCH] Researching ${topic.name}...`);
        const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topicName + ' latest 2025')}&count=5`;
        
        const braveRes = await fetch(braveUrl, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': braveKey
          }
        });
        
        if (braveRes.ok) {
          const braveData = await braveRes.json();
          if (braveData.web && braveData.web.results) {
            const braveResults = braveData.web.results.slice(0, 3);
            braveResults.forEach((r, i) => {
              research.push(`[BRAVE-${i + 1}] ${r.title}: ${r.description.substring(0, 100)}`);
              sources++;
            });
            console.log(`[BRAVE-SEARCH] ✓ Got ${braveResults.length} web results`);
          }
        }
      }
    } catch (e) {
      console.log(`[BRAVE-SEARCH] Error: ${e.message}`);
    }
    
    // LAYER 2: Twitter API search
    try {
      console.log(`[TWITTER-SEARCH] Researching ${topic.name}...`);
      const query = `${topicName} -is:retweet`;
      
      const searchRes = await v2Client.get('tweets/search/recent', {
        query: query,
        'tweet.fields': 'public_metrics,created_at',
        max_results: 5
      });
      
      if (searchRes.data && searchRes.data.length > 0) {
        const tweets = searchRes.data.slice(0, 3);
        tweets.forEach((t, i) => {
          research.push(`[TWITTER-${i + 1}] ${t.text.substring(0, 100)} (${t.public_metrics?.like_count || 0} likes)`);
          sources++;
        });
        console.log(`[TWITTER-SEARCH] ✓ Got ${tweets.length} tweets`);
      }
    } catch (e) {
      console.log(`[TWITTER-SEARCH] Error: ${e.message}`);
    }
    
    if (research.length === 0) {
      console.log(`[RESEARCH] No data found for ${topic.name}`);
      return null;
    }
    
    return {
      topic: topic.name,
      type: topic.type,
      research: research.join('\n\n'),
      sources: sources
    };
  } catch (e) {
    console.log(`[RESEARCH] Failed for ${topic.name}: ${e.message}`);
    return null;
  }
}

async function buildContextKnowledge(conversationThread, v2Client) {
  console.log(`[RESEARCH] Analyzing ${conversationThread.length} tweets in thread...`);
  
  // Get topics
  const topics = await identifyTopics(conversationThread);
  console.log(`[RESEARCH] Identified ${topics.length} topics`);
  
  // PRIORITIZE PROJECTS (@mentions) - research all of them
  const projects = topics.filter(t => t.type === 'project');
  const concepts = topics.filter(t => t.type !== 'project');
  
  console.log(`[RESEARCH] Found ${projects.length} projects to research`);
  
  // Build summary of conversation
  const conversationSummary = conversationThread
    .map(t => `- ${t.text}`)
    .join('\n');
  
  // Research all projects (critical for multi-project comparison)
  const research = [];
  const projectsToResearch = projects.length > 0 ? projects : topics;
  
  // Use Twitter API for research (always available)
  console.log(`[RESEARCH] Using Twitter API to research topics`);
  for (const topic of projectsToResearch.slice(0, 8)) {
    console.log(`[RESEARCH] Researching: ${topic.name} (${topic.type})`);
    const result = await deepResearchTopic(topic, v2Client);
    if (result) {
      research.push(result);
      console.log(`[RESEARCH] ✓ Got ${result.sources} tweets about ${topic.name}`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  
  return {
    conversationSummary,
    topics,
    projects,
    research,
    threadLength: conversationThread.length
  };
}

export { fetchFullConversation, identifyTopics, deepResearchTopic, buildContextKnowledge };
