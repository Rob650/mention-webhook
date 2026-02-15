# Deployment Steps - Graisonbot Webhook

## Timeline: 15 minutes to live

### Step 1: Prepare Credentials (2 min)

Get your credentials from:
- **Twitter API**: https://developer.twitter.com/en/portal/dashboard
  - API Key (Consumer Key)
  - API Secret (Consumer Secret)
  - Access Token
  - Access Token Secret

- **Anthropic API**: https://console.anthropic.com/account/billing
  - API Key

### Step 2: Create .env File (1 min)

```bash
cd mention-webhook
cp .env.example .env
```

Edit `.env`:
```
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_token_secret
ANTHROPIC_API_KEY=your_anthropic_key
PORT=3000
```

### Step 3: Install Dependencies (2 min)

```bash
npm install
```

### Step 4: Test Locally (3 min)

```bash
npm start
```

Should see:
```
🚀 GRAISONBOT WEBHOOK SERVER
Listening on port 3000
```

Test health:
```bash
curl http://localhost:3000/health
```

### Step 5: Deploy to Railway (5 min)

1. **Create Railway account** → https://railway.app
2. **Connect GitHub** (auth with GitHub)
3. **Create new project** → Select this repo
4. **Set environment variables**:
   - Go to Variables
   - Add all .env variables
5. **Deploy** (automatic on push)
6. **Get public URL** from Railway dashboard
   - Example: `https://mention-webhook-production.up.railway.app`

### Step 6: Register Webhook (2 min)

Create `register-webhook.js` in project root:

```javascript
import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';
dotenv.config();

const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function register() {
  try {
    const env = await client.v2.webhooks.register({
      url: 'https://your-railway-url.com/webhooks/twitter',
      environment: 'production'
    });
    console.log('✅ Webhook registered:', env);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

register();
```

Run:
```bash
node register-webhook.js
```

### Step 7: Test Live (1 min)

Mention @graisonbot from a **verified account**:

```
@graisonbot what's the latest on AI agents? 🤖
```

Watch for reply within 30 seconds!

Check stats:
```bash
curl https://your-railway-url.com/stats
```

---

## Troubleshooting During Deployment

### "Module not found" errors
```bash
npm install
rm -rf node_modules package-lock.json
npm install
```

### Port 3000 already in use
```bash
lsof -ti:3000 | xargs kill -9
npm start
```

### "Cannot find module './src/db.js'"
Make sure directory structure is:
```
mention-webhook/
  ├── server.js
  ├── src/
  │  ├── db.js
  │  └── filters.js
  └── package.json
```

### Railway deployment fails
1. Check Node version: `node -v` (should be 16+)
2. Check package.json has `"main": "server.js"`
3. Check .env variables are set in Railway dashboard

### Webhook not receiving mentions
1. Verify webhook URL in Railway is public
2. Check registration succeeded (no errors in register-webhook.js)
3. Try mentioning from verified account (must be blue check)
4. Wait 5-10 seconds for delivery

---

## Verify Everything Works

### 1. Health Check
```bash
curl https://your-railway-url.com/health
# {"status":"ok","timestamp":"..."}
```

### 2. Check Stats
```bash
curl https://your-railway-url.com/stats
# {"total_replies":0,"unique_users":0,...}
```

### 3. Simulate Mention (curl)
```bash
curl -X POST https://your-railway-url.com/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "tweet_create_events": [{
      "id_str": "123456789",
      "text": "@graisonbot test mention",
      "user": {
        "id_str": "987654321",
        "screen_name": "testuser",
        "verified": true,
        "followers_count": 50000
      }
    }]
  }'
```

### 4. Check Database
```bash
sqlite3 graisonbot.db "SELECT COUNT(*) FROM mentions;"
```

---

## After Deployment

### Daily Monitoring
- [ ] Check stats endpoint: `https://your-url.com/stats`
- [ ] View recent replies: `https://your-url.com/api/replies?hours=24`
- [ ] Monitor Twitter API spend (should be $0.28/day)
- [ ] Monitor Anthropic API spend (should be $0.08/day)

### Weekly Review
- [ ] How many mentions? (`unique_users` in stats)
- [ ] Any errors in Railway logs?
- [ ] Engagement on posted replies good?
- [ ] Adjust reply filter if needed

### Monthly
- [ ] Check total cost: $8.40 expected
- [ ] Review reply quality
- [ ] Update filters if new use cases emerge

---

## Next: Broadcaster System

The webhook is deployed! Now let's rebuild the broadcaster (separate from this).

See `/Users/roberttjan/.openclaw/workspace/ai-research-v5/broadcaster-fixed.js`
