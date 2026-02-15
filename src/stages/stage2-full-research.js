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
    // For projects (@mentions), search specifically for recent updates/news
    let query = topic.name;
    if (topic.type === 'project') {
      query = `${topic.name} latest updates 2025 OR ${topic.name} shipping OR ${topic.name} announcement`;
    }
    
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&freshness=pw`;
    const res = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY || ''
      }
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    if (!data.web || !data.web.results) return null;
    
    // Extract useful information - prioritize recent news
    const results = data.web.results.slice(0, 5);
    const researchItems = results.map(r => ({
      title: r.title,
      snippet: r.description,
      url: r.url,
      timestamp: r.page_age
    }));
    
    const researchSummary = researchItems
      .map(r => `[${r.title}] ${r.snippet}`)
      .join('\n\n');
    
    return {
      topic: topic.name,
      type: topic.type,
      research: researchSummary,
      items: researchItems,
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
  
  // PRIORITIZE PROJECTS (@mentions) - research all of them
  const projects = topics.filter(t => t.type === 'project');
  const concepts = topics.filter(t => t.type !== 'project');
  
  console.log(`[RESEARCH] Found ${projects.length} projects to research`);
  
  // Research all projects (critical for multi-project comparison)
  const research = [];
  const projectsToResearch = projects.length > 0 ? projects : topics;
  
  for (const topic of projectsToResearch.slice(0, 8)) {
    console.log(`[RESEARCH] Researching: ${topic.name} (${topic.type})`);
    const result = await deepResearchTopic(topic);
    if (result) {
      research.push(result);
      console.log(`[RESEARCH] ✓ Got ${result.sources} sources on ${topic.name}`);
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
    projects,
    research,
    threadLength: conversationThread.length
  };
}

export { fetchFullConversation, identifyTopics, deepResearchTopic, buildContextKnowledge };
