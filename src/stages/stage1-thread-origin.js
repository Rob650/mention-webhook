#!/usr/bin/env node

/**
 * THREAD ORIGIN STAGE
 * 1. Find the ORIGINAL tweet (root of conversation)
 * 2. Understand what it's about
 * 3. Follow the thread evolution
 * 4. Understand current context within that evolution
 */

async function findThreadOrigin(conversationId, v2Client) {
  try {
    // Get ALL tweets in this conversation (up to 100)
    const allTweets = await v2Client.get('tweets/search/recent', {
      query: `conversation_id:${conversationId}`,
      'tweet.fields': 'created_at,public_metrics,author_id',
      max_results: 100
    });
    
    if (!allTweets.data || allTweets.data.length === 0) {
      return null;
    }
    
    // Sort by creation time (earliest = root)
    const sorted = allTweets.data.sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    
    // First tweet is the root
    const rootTweet = sorted[0];
    
    return {
      root: rootTweet,
      allTweets: sorted,
      threadLength: sorted.length
    };
  } catch (e) {
    console.error(`[ERROR] Failed to find thread origin: ${e.message}`);
    return null;
  }
}

function analyzeThreadEvolution(threadData) {
  if (!threadData) return null;
  
  const { root, allTweets } = threadData;
  
  // Extract core message from original post
  const originalText = root.text;
  let coreMessage = 'Unknown topic';
  
  // Identify what the original post is about
  if (originalText.toLowerCase().includes('buy') || originalText.toLowerCase().includes('sell') || originalText.toLowerCase().includes('price')) {
    coreMessage = 'Price action / Trading decision';
  } else if (originalText.toLowerCase().includes('ship') || originalText.toLowerCase().includes('launch') || originalText.toLowerCase().includes('build')) {
    coreMessage = 'Product launch / Development milestone';
  } else if (originalText.toLowerCase().includes('team') || originalText.toLowerCase().includes('hire') || originalText.toLowerCase().includes('join')) {
    coreMessage = 'Team / Hiring / People';
  } else if (originalText.toLowerCase().includes('fund') || originalText.toLowerCase().includes('raise') || originalText.toLowerCase().includes('capital')) {
    coreMessage = 'Fundraising / Capital';
  } else if (originalText.toLowerCase().includes('partnership') || originalText.toLowerCase().includes('integrat') || originalText.toLowerCase().includes('collab')) {
    coreMessage = 'Partnership / Integration / Collaboration';
  } else if (originalText.toLowerCase().includes('thanks') || originalText.toLowerCase().includes('honor') || originalText.toLowerCase().includes('grateful')) {
    coreMessage = 'Gratitude / Appreciation / Milestone celebration';
  } else if (originalText.toLowerCase().includes('announcement') || originalText.toLowerCase().includes('excited') || originalText.toLowerCase().includes('thrilled')) {
    coreMessage = 'Announcement / Exciting news';
  } else {
    coreMessage = originalText.substring(0, 80);
  }
  
  // Analyze thread evolution
  const timeline = allTweets.map((t, idx) => ({
    position: idx + 1,
    totalInThread: allTweets.length,
    text: t.text.substring(0, 100),
    timestamp: t.created_at,
    engagement: t.public_metrics?.like_count || 0
  }));
  
  return {
    originalTopic: root.text,
    coreMessage: coreMessage,
    originalTimestamp: root.created_at,
    threadLength: allTweets.length,
    timeline: timeline,
    latestTweet: allTweets[allTweets.length - 1],
    evolutionSummary: `Started: "${root.text.substring(0, 80)}..." → Now at tweet ${allTweets.length}`
  };
}

function buildContextFromOrigin(threadData, currentMentionPosition) {
  if (!threadData) return null;
  
  const { originalTopic, threadLength, timeline } = threadData;
  
  // What's the topic?
  const topicSummary = originalTopic;
  
  // Where are we in the evolution?
  const positionInThread = currentMentionPosition || threadLength;
  const evolutionPercent = Math.round((positionInThread / threadLength) * 100);
  
  return {
    originalTopic: topicSummary,
    positionInThread,
    totalThreadLength: threadLength,
    evolutionPercent,
    context: `Conversation started with: "${topicSummary.substring(0, 120)}". We're at tweet ${positionInThread}/${threadLength}.`
  };
}

export { findThreadOrigin, analyzeThreadEvolution, buildContextFromOrigin };
