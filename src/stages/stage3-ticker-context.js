#!/usr/bin/env node

/**
 * TICKER/PROJECT CONTEXT STAGE
 * Extract $tickers and @projects mentioned
 * Research what they're specifically doing
 * Build project-specific knowledge
 */

function extractTickers(conversationText) {
  // Find all $SYMBOL mentions
  const tickerPattern = /\$[A-Z][A-Z0-9]*/gi;
  const matches = conversationText.match(tickerPattern) || [];
  
  // Remove duplicates and return
  return [...new Set(matches.map(t => t.toUpperCase()))];
}

function extractProjectMentions(conversationText) {
  // Find all @mentions
  const mentionPattern = /@[a-zA-Z0-9_]+/g;
  const matches = conversationText.match(mentionPattern) || [];
  
  return [...new Set(matches)];
}

async function researchTickerProject(ticker, v2Client) {
  try {
    // Search Twitter for recent discussion about this ticker
    const tickerName = ticker.replace('$', '');
    const query = `${ticker} OR "${tickerName}" -is:retweet`;
    
    console.log(`[TICKER-RESEARCH] Researching ${ticker}...`);
    
    const searchRes = await v2Client.get('tweets/search/recent', {
      query: query,
      'tweet.fields': 'public_metrics,created_at',
      max_results: 5
    });
    
    if (!searchRes.data || searchRes.data.length === 0) {
      console.log(`[TICKER-RESEARCH] No tweets found for ${ticker}`);
      return null;
    }
    
    // Extract what people are saying about this ticker
    const tweets = searchRes.data;
    const context = tweets
      .map(t => t.text.substring(0, 150))
      .join('\n\n');
    
    return {
      ticker: ticker,
      context: context,
      tweets: tweets.length,
      sentiment: analyzeSentiment(tweets)
    };
  } catch (e) {
    console.log(`[TICKER-RESEARCH] Error: ${e.message}`);
    return null;
  }
}

function analyzeSentiment(tweets) {
  // Simple sentiment analysis based on keywords
  const bullishWords = ['buy', 'accumulate', 'diamond', 'hold', 'moon', 'shipping', 'executive', 'launch'];
  const bearishWords = ['sell', 'dump', 'rug', 'scam', 'dying', 'fail', 'red', 'bearish'];
  
  let bullish = 0, bearish = 0;
  
  tweets.forEach(t => {
    const text = t.text.toLowerCase();
    bullishWords.forEach(w => {
      if (text.includes(w)) bullish++;
    });
    bearishWords.forEach(w => {
      if (text.includes(w)) bearish++;
    });
  });
  
  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';
  return 'neutral';
}

export { extractTickers, extractProjectMentions, researchTickerProject, analyzeSentiment };
