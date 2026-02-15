#!/usr/bin/env node

import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_KEY = process.env.TWITTER_API_KEY;
const API_SECRET = process.env.TWITTER_API_SECRET;
const ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;

function generateOAuthHeader(method, endpoint, additionalParams = {}) {
  const oauth_consumer_key = API_KEY;
  const oauth_token = ACCESS_TOKEN;
  const oauth_signature_method = 'HMAC-SHA1';
  const oauth_timestamp = Math.floor(Date.now() / 1000).toString();
  const oauth_nonce = crypto.randomBytes(16).toString('hex');
  const oauth_version = '1.0';

  const params = {
    oauth_consumer_key,
    oauth_token,
    oauth_signature_method,
    oauth_timestamp,
    oauth_nonce,
    oauth_version,
    ...additionalParams
  };

  const sorted = Object.keys(params)
    .sort()
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');

  const base = `${method}&${encodeURIComponent(endpoint)}&${encodeURIComponent(sorted)}`;
  const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');

  const authParams = {
    ...params,
    oauth_signature: signature
  };

  return 'OAuth ' + Object.keys(authParams)
    .sort()
    .map(key => `${key}="${encodeURIComponent(authParams[key])}"`)
    .join(', ');
}

async function registerWebhook() {
  try {
    console.log('📡 Registering webhook with Twitter...');
    console.log(`   URL: ${WEBHOOK_URL}`);
    console.log('');

    const endpoint = 'https://api.twitter.com/2/account_activity/all/production/webhooks';
    
    const authHeader = generateOAuthHeader('POST', endpoint, {
      url: WEBHOOK_URL
    });

    const response = await axios.post(endpoint, { url: WEBHOOK_URL }, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Webhook registered successfully!');
    console.log(`   ID: ${response.data.id}`);
    console.log(`   URL: ${response.data.url}`);
    console.log('');
    console.log('Your webhook is now LIVE! 🎉');
    console.log('');
    console.log('Test it:');
    console.log('  1. Mention @graisonbot from a verified account');
    console.log('  2. You should get a reply within 5-10 seconds');
    console.log('');

  } catch (error) {
    console.error('❌ Registration failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    console.error('');
    console.error('Note: If you get a 403, this is expected.');
    console.error('Twitter webhooks are being phased out.');
    console.error('Your webhook server is still LIVE on Railway!');
    process.exit(1);
  }
}

registerWebhook();
