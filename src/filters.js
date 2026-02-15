/**
 * Filters - Determine if we should reply to a mention
 */

/**
 * Check if mention passes all filters
 */
export function shouldReplyTo(mention) {
  // Filter 1: Must be from verified account
  if (!mention.user.verified) {
    return false;
  }

  // Filter 2: Must mention @graisonbot
  if (!mention.text.toLowerCase().includes('@graisonbot')) {
    return false;
  }

  // Filter 3: Skip retweets
  if (mention.text.startsWith('RT @')) {
    return false;
  }

  // Filter 4: Skip if it's a reply to someone else (we want original mentions)
  if (mention.in_reply_to_screen_name && mention.in_reply_to_screen_name !== 'graisonbot') {
    return false;
  }

  // All filters passed
  return true;
}

/**
 * Extract context from mention for better reply generation
 */
export function extractMentionContext(text) {
  // Look for keywords to understand topic
  const keywords = {
    crypto: ['bitcoin', 'ethereum', 'solana', 'token', 'defi', 'nft', 'web3'],
    ai: ['ai', 'llm', 'agent', 'model', 'neural', 'transformer', 'gpt'],
    agents: ['agent', 'autonomous', 'bot', 'automation', 'intelligent'],
    trading: ['trade', 'buy', 'sell', 'price', 'pump', 'dump', 'volume'],
  };

  const lowerText = text.toLowerCase();
  const topics = [];

  for (const [topic, words] of Object.entries(keywords)) {
    if (words.some((word) => lowerText.includes(word))) {
      topics.push(topic);
    }
  }

  // Return context string
  if (topics.length > 0) {
    return `Topics: ${topics.join(', ')}`;
  }

  return '';
}

/**
 * Format mention into readable summary
 */
export function formatMention(mention) {
  return {
    id: mention.id_str,
    author: mention.user.screen_name,
    verified: mention.user.verified,
    followers: mention.user.followers_count,
    text: mention.text,
    created_at: mention.created_at,
  };
}
