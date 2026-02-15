#!/usr/bin/env node

/**
 * ONE-TIME SETUP: Configure Twitter Filtered Stream Rules
 * Run this once to set up the stream filter
 */

import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';

dotenv.config();

const twitterBearer = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

async function setupStreamRules() {
  try {
    console.log('📡 Setting up Twitter Filtered Stream rules...\n');

    // Get existing rules
    const existingRules = await twitterBearer.v2.streamRules();
    
    if (existingRules.data && existingRules.data.length > 0) {
      console.log(`Found ${existingRules.data.length} existing rule(s). Deleting...`);
      await twitterBearer.v2.updateStreamRules({
        delete: { ids: existingRules.data.map(r => r.id) }
      });
      console.log('✓ Deleted old rules\n');
    }

    // Add new rule
    const newRules = await twitterBearer.v2.updateStreamRules({
      add: [
        {
          value: '@graisonbot -is:retweet',
          tag: 'mentions'
        }
      ]
    });

    console.log('✅ Stream rule configured:');
    console.log(`   Rule: ${newRules.data[0].value}`);
    console.log(`   Tag: ${newRules.data[0].tag}`);
    console.log(`   ID: ${newRules.data[0].id}`);
    console.log('\n✅ Ready to receive mentions in real-time!');
    console.log('   Deploy to Railway and start receiving mentions instantly.\n');

  } catch (error) {
    console.error('❌ Failed to setup stream rules:');
    console.error(error.message);
    process.exit(1);
  }
}

setupStreamRules();
