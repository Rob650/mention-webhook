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

const v2Client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN).readOnlyClient;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  
  // Use AI to identify topics mentioned
  const threadText = conversationThread
    .map(t => t.text)
    .join('\n---\n');
  
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract ALL topics, projects, companies, and concepts mentioned in this thread:

${threadText}

Return JSON array format:
[
  { "name": "TopicName", "type": "project|company|concept|technology", "mentions": 2 },
  ...
]

List each unique topic once with mention count.`
      }]
    });
    
    const text = msg.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to identify topics: ${e.message}`);
  }
  
  return [];
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
