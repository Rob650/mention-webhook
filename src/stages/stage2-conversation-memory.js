#!/usr/bin/env node

/**
 * CONVERSATION MEMORY STAGE
 * Track what we've said to each author in each conversation
 * Understand follow-ups vs new topics
 * Don't repeat ourselves
 */

import fs from 'fs';

const CONVO_MEMORY_FILE = '/Users/roberttjan/.openclaw/workspace/mention-webhook/data/conversation-memory.jsonl';

// Format: { author_id, conversation_id, last_reply, last_reply_time, reply_count }
let conversationMemory = new Map(); // Key: "author_id:conversation_id"

function loadConversationMemory() {
  try {
    if (fs.existsSync(CONVO_MEMORY_FILE)) {
      const lines = fs.readFileSync(CONVO_MEMORY_FILE, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        const entry = JSON.parse(line);
        const key = `${entry.author_id}:${entry.conversation_id}`;
        conversationMemory.set(key, entry);
      }
      console.log(`[MEMORY] Loaded ${conversationMemory.size} conversation histories`);
    }
  } catch (e) {
    console.error(`[MEMORY] Error loading conversation memory: ${e.message}`);
  }
}

function getConversationContext(authorId, conversationId) {
  const key = `${authorId}:${conversationId}`;
  return conversationMemory.get(key) || null;
}

function saveReplyToMemory(authorId, conversationId, replyText, mentionText) {
  const key = `${authorId}:${conversationId}`;
  const entry = {
    author_id: authorId,
    conversation_id: conversationId,
    last_reply: replyText.substring(0, 200),
    last_mention: mentionText.substring(0, 200),
    last_reply_time: new Date().toISOString(),
    reply_count: (conversationMemory.get(key)?.reply_count || 0) + 1
  };
  
  conversationMemory.set(key, entry);
  
  // Persist to file
  try {
    const lines = Array.from(conversationMemory.values())
      .map(e => JSON.stringify(e))
      .join('\n') + '\n';
    fs.writeFileSync(CONVO_MEMORY_FILE, lines, 'utf8');
  } catch (e) {
    console.error(`[MEMORY] Error saving: ${e.message}`);
  }
  
  return entry;
}

function isFollowUp(authorId, conversationId, mentionText) {
  const context = getConversationContext(authorId, conversationId);
  if (!context) return false;
  
  // Follow-up signals:
  // 1. Same author in same conversation (context exists)
  // 2. Within last 5 minutes
  // 3. Not the same text as last mention
  const timeDiff = Date.now() - new Date(context.last_reply_time).getTime();
  const withinWindow = timeDiff < 300000; // 5 minutes
  const differentText = mentionText.substring(0, 100) !== context.last_mention.substring(0, 100);
  
  return withinWindow && differentText;
}

function getFollowUpContext(authorId, conversationId) {
  const context = getConversationContext(authorId, conversationId);
  if (!context) return null;
  
  return {
    previousReply: context.last_reply,
    previousMention: context.last_mention,
    replyCount: context.reply_count,
    isFollowUp: true
  };
}

export { loadConversationMemory, getConversationContext, saveReplyToMemory, isFollowUp, getFollowUpContext };
