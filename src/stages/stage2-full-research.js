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

async function deepResearchTopic(topic) {
  try {
    // Brave search for the topic
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topic.name)}&count=10`;
    const res = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY || ''
      }
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    if (!data.web || !data.web.results) return null;
    
    // Extract useful information
    const results = data.web.results.slice(0, 5);
    const researchSummary = results
      .map(r => `${r.title}\n${r.description}`)
      .join('\n\n');
    
    return {
      topic: topic.name,
      type: topic.type,
      research: researchSummary,
      sources: results.length
    };
  } catch (e) {
    console.error(`[ERROR] Failed to research ${topic.name}: ${e.message}`);
    return null;
  }
}

async function buildContextKnowledge(conversationThread) {
  console.log(`[RESEARCH] Analyzing ${conversationThread.length} tweets in thread...`);
  
  // Get topics
  const topics = await identifyTopics(conversationThread);
  console.log(`[RESEARCH] Identified ${topics.length} topics`);
  
  if (topics.length === 0) {
    return {
      conversationSummary: conversationThread.map(t => t.text).join('\n'),
      topics: [],
      research: []
    };
  }
  
  // Research each topic (max 5 to avoid rate limits)
  const research = [];
  for (const topic of topics.slice(0, 5)) {
    console.log(`[RESEARCH] Researching: ${topic.name}`);
    const result = await deepResearchTopic(topic);
    if (result) {
      research.push(result);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Build summary of conversation
  const conversationSummary = conversationThread
    .map(t => `- ${t.text}`)
    .join('\n');
  
  return {
    conversationSummary,
    topics,
    research,
    threadLength: conversationThread.length
  };
}

export { fetchFullConversation, identifyTopics, deepResearchTopic, buildContextKnowledge };
