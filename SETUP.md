# Graisonbot Webhook Setup Guide

## Quick Start (5 minutes)

### 1. Install Dependencies
```bash
cd mention-webhook
npm install
```

### 2. Create .env file
```bash
cp .env.example .env
```

Fill in your credentials:
```
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_TOKEN_SECRET=...
ANTHROPIC_API_KEY=...
PORT=3000
```

### 3. Start Server (Local Testing)
```bash
npm start
```

Should output:
```
🚀 GRAISONBOT WEBHOOK SERVER
Listening on port 3000
Webhook URL: https://your-domain.com/webhooks/twitter
```

---

## Deploy to Railway (Free Tier)

### 1. Create Railway Account
- Go to https://railway.app
- Sign up with GitHub
- Create new project

### 2. Connect to Repo
- Click "Deploy from GitHub"
- Select this repo
- Railway auto-detects Node.js

### 3. Set Environment Variables
In Railway dashboard:
- Go to Variables
- Add all .env variables:
  - TWITTER_API_KEY
  - TWITTER_API_SECRET
  - TWITTER_ACCESS_TOKEN
  - TWITTER_ACCESS_TOKEN_SECRET
  - ANTHROPIC_API_KEY
  - PORT=3000

### 4. Get Public URL
- Railway assigns: `https://mention-webhook-production.up.railway.app`
- This is your WEBHOOK_URL

### 5. Register Webhook with Twitter
See "Register Webhook" section below

---

## Register Webhook with Twitter

### Option A: Using curl

```bash
# Get your app's bearer token first
BEARER_TOKEN="your_bearer_token"
WEBHOOK_URL="https://your-domain.com/webhooks/twitter"

# Register webhook
curl -X POST "https://api.twitter.com/2/tweets/search/stream/rules" \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"add":[{"value":"@graisonbot verified"}]}'
```

### Option B: Using your app (recommended)

Create `register-webhook.js`:

```javascript
import { TwitterApi } from 'twitter-api-v2';

const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function registerWebhook() {
  try {
    // Register webhook environment
    const webhook = await client.v2.webhooks.register({
      url: process.env.WEBHOOK_URL,
      environment: 'production'
    });
    
    console.log('✅ Webhook registered:', webhook);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

registerWebhook();
```

Run:
```bash
node register-webhook.js
```

---

## Testing

### Health Check
```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-02-15T..."}
```

### Stats
```bash
curl http://localhost:3000/stats
# {"total_replies":5,"unique_users":3,"last_reply":"2026-02-15T..."}
```

### Simulate Mention (for testing)
```bash
curl -X POST http://localhost:3000/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "tweet_create_events": [{
      "id_str": "123456789",
      "text": "@graisonbot what do you think about solana?",
      "user": {
        "id_str": "987654321",
        "screen_name": "testuser",
        "verified": true,
        "followers_count": 50000
      }
    }]
  }'
```

---

## Monitoring

### View Recent Replies
```
GET http://localhost:3000/api/replies?hours=24
```

### View Database
```bash
sqlite3 graisonbot.db ".tables"
sqlite3 graisonbot.db "SELECT * FROM mentions ORDER BY timestamp DESC LIMIT 10;"
```

---

## Cost Breakdown

### Per Reply
- Claude Haiku: $0.004
- Twitter POST: $0.010
- **Total: $0.014 per reply**

### Daily (20 replies)
- Claude: $0.08
- Twitter: $0.20
- **Total: $0.28/day**

### Monthly
- **$8.40**

### Yearly
- **~$100**

---

## Troubleshooting

### "CRC Challenge Failed"
- Check TWITTER_API_SECRET is correct
- Verify hashCRC function is working

### "403 Unauthorized"
- Check API credentials
- Verify app has write permissions
- Check webhook environment is correct

### "No mentions received"
- Check webhook is registered
- Verify webhook URL is publicly accessible
- Check Twitter stream filter is active

### Database locked
- Kill any sqlite processes: `pkill sqlite3`
- Delete graisonbot.db and restart (will recreate)

---

## Production Checklist

- [ ] Environment variables set on Railway
- [ ] Webhook URL registered with Twitter
- [ ] Database backups configured
- [ ] Error logging setup (optional: Sentry)
- [ ] Monitor responses (check `/health` endpoint)
- [ ] Track API spend on Twitter Developer Console
- [ ] Track API spend on Anthropic Console

---

## Next Steps

1. Deploy to Railway
2. Register webhook
3. Mention @graisonbot from verified account
4. Watch replies come in!
