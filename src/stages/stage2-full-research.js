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
    // Use Twitter API to search for what's being said about this topic
    const query = `${topic.name.replace('@', '')} -is:retweet`;
    
    console.log(`[TWITTER-SEARCH] Researching ${topic.name}: "${query}"`);
    
    const searchRes = await v2Client.get('tweets/search/recent', {
      query: query,
      'tweet.fields': 'public_metrics,created_at,author_id',
      max_results: 10
    });
    
    if (!searchRes.data || searchRes.data.length === 0) {
      console.log(`[TWITTER-SEARCH] No tweets found for ${topic.name}`);
      return null;
    }
    
    // Extract insights from tweets about this topic
    const tweets = searchRes.data.slice(0, 5);
    const researchItems = tweets.map(t => ({
      text: t.text.substring(0, 150),
      engagement: t.public_metrics?.like_count || 0,
      created_at: t.created_at
    }));
    
    const researchSummary = researchItems
      .map((r, i) => `[${i + 1}] ${r.text} (${r.engagement} likes)`)
      .join('\n\n');
    
    return {
      topic: topic.name,
      type: topic.type,
      research: researchSummary,
      items: researchItems,
      sources: researchItems.length
    };
  } catch (e) {
    console.log(`[TWITTER-SEARCH] Failed for ${topic.name}: ${e.message}`);
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
