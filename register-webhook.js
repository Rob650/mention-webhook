#!/usr/bin/env node

/**
 * REGISTER WEBHOOK WITH TWITTER
 * 
 * One-time setup: registers your webhook URL with Twitter
 * Run this after deploying to Railway
 */

import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';

dotenv.config();

const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function registerWebhook() {
  try {
    if (!process.env.WEBHOOK_URL) {
      console.error('❌ WEBHOOK_URL not set in .env');
      console.error('   Add: WEBHOOK_URL=https://your-railway-url.com/webhooks/twitter');
      process.exit(1);
    }

    console.log('📡 Registering webhook with Twitter...');
    console.log(`   URL: ${process.env.WEBHOOK_URL}`);

    const webhook = await client.v2.webhooks.register({
      url: process.env.WEBHOOK_URL,
      environment: 'production'
    });

    console.log('✅ Webhook registered successfully!');
    console.log(`   ID: ${webhook.id}`);
    console.log(`   URL: ${webhook.url}`);
    console.log(`   Valid: ${webhook.valid}`);
    console.log('');
    console.log('Your webhook is now live. Mentions will be sent in real-time.');
    console.log('');
    console.log('Test it:');
    console.log('  1. Mention @graisonbot from a verified account');
    console.log('  2. You should get a reply within 5-10 seconds');
    console.log('  3. Check stats: curl https://your-url.com/stats');

  } catch (error) {
    console.error('❌ Registration failed:');
    console.error(`   ${error.message}`);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  • Check WEBHOOK_URL is correct and public');
    console.error('  • Check Twitter API credentials in .env');
    console.error('  • Verify app has write permissions');
    process.exit(1);
  }
}

registerWebhook();
