# ✅ Production Ready - Webhook Mention System v2

## What's New in v2

- ✅ **Comprehensive logging** (logger.js)
- ✅ **Analytics & monitoring** (analytics.js)
- ✅ **Live dashboard** (monitor.js)
- ✅ **Error handling** (all components)
- ✅ **Graceful shutdown** (SIGINT handler)
- ✅ **Railway deployment** (railway.json)
- ✅ **Register webhook** (register-webhook.js)
- ✅ **Better stats** (/stats endpoint)

---

## Quick Deploy (15 minutes)

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env with your credentials:
#   TWITTER_API_KEY=...
#   TWITTER_API_SECRET=...
#   TWITTER_ACCESS_TOKEN=...
#   TWITTER_ACCESS_TOKEN_SECRET=...
#   ANTHROPIC_API_KEY=...
#   WEBHOOK_URL=https://your-railway-url.com/webhooks/twitter
```

### 3. Test Locally
```bash
npm start
# In another terminal:
curl http://localhost:3000/health
```

### 4. Deploy to Railway
```bash
# Push to GitHub
git add .
git commit -m "Add webhook v2"
git push origin main

# Railway auto-deploys
# Get public URL from dashboard
```

### 5. Register Webhook
```bash
# Update .env with Railway URL
WEBHOOK_URL=https://your-railway-url.com/webhooks/twitter

# Register
npm run register

# Output: ✅ Webhook registered successfully!
```

### 6. Test Live
- Mention @graisonbot from verified account
- Should get reply in 5-10 seconds
- Check: `curl https://your-url.com/stats`

---

## Available Commands

### Start Server
```bash
npm start                 # Production mode
npm run dev             # Development (with nodemon)
```

### Monitor & Analytics
```bash
npm run monitor         # Live dashboard
curl http://localhost:3000/health
curl http://localhost:3000/stats
curl "http://localhost:3000/api/replies?hours=24"
```

### Setup
```bash
npm run register        # Register webhook with Twitter
node test-webhook.sh    # Simulate a mention
```

---

## Monitoring Endpoints

### Health Check
```bash
curl http://localhost:3000/health
# {"status":"ok","mentions_received":5,"replies_sent":3}
```

### Live Stats
```bash
curl http://localhost:3000/stats
# {
#   "total_replies": 15,
#   "unique_users": 8,
#   "cost_per_reply": "$0.014",
#   "estimated_daily_average": "$0.28",
#   "estimated_monthly": "$8.40"
# }
```

### Recent Replies (24 hours)
```bash
curl "http://localhost:3000/api/replies?hours=24"
# {"count": 3, "replies": [...]}
```

---

## Logs & Analytics

### Log Files
- **analytics.jsonl** - All events (mentions, replies, errors)
- **graisonbot.db** - SQLite database (replies, dedup)

### View Recent Events
```bash
tail -f analytics.jsonl
```

### Live Dashboard
```bash
npm run monitor

# Shows:
# - 24h stats (mentions, replies, cost)
# - 7d stats
# - Top authors
# - Cost projections
# - Refreshes every 30 seconds
```

---

## Cost Tracking

### Per Reply
- Claude Haiku: $0.004
- Twitter POST: $0.010
- **Total: $0.014**

### Daily (20 replies)
- Claude: $0.08
- Twitter: $0.20
- **Total: $0.28**

### Monitor Spend
- Twitter: https://developer.twitter.com/en/account/billing
- Anthropic: https://console.anthropic.com/account/billing

---

## Error Handling

### Common Issues

**"Unauthorized" errors**
```
→ Check API credentials in .env
→ Verify Twitter app write permissions
→ Check Anthropic API key valid
```

**"Webhook not receiving mentions"**
```
→ Verify webhook URL is public
→ Verify registration succeeded (npm run register)
→ Try mentioning from verified account
→ Check logs: tail -f analytics.jsonl
```

**"CRC challenge failed"**
```
→ Verify TWITTER_API_SECRET correct
→ Check registration process
```

### View Errors
```bash
grep '"type":"error"' analytics.jsonl | tail -10
```

---

## Production Checklist

- [ ] Environment variables set on Railway
- [ ] WEBHOOK_URL configured in .env
- [ ] Webhook registered with Twitter (`npm run register`)
- [ ] Health endpoint responding (`curl /health`)
- [ ] Stats endpoint responding (`curl /stats`)
- [ ] Database created (first run auto-creates)
- [ ] Test mention received & replied
- [ ] Logs visible in Railway dashboard
- [ ] Cost tracking enabled (check endpoints)
- [ ] Error monitoring active

---

## Architecture

```
Twitter
  ↓
Webhook POST (real-time, free)
  ↓
Your Server (Express)
  ├─ Verify signature (CRC)
  ├─ Filter mention
  │  ├─ Check verified
  │  ├─ Check mentions @graisonbot
  │  ├─ Check not replied recently
  │  └─ Extract context
  ├─ Generate reply (Claude Haiku, $0.004)
  ├─ Post reply (Twitter API, $0.010)
  ├─ Store in database (SQLite)
  ├─ Log analytics (analytics.jsonl)
  └─ Respond 200 OK to Twitter

Total cycle: ~5 seconds
Cost: $0.014 per reply
```

---

## Scaling

### Add More Verified Accounts to Monitor
Edit `src/filters.js`:
```javascript
// Add more keywords to detect topics
const keywords = {
  crypto: [..., 'your_new_keyword'],
  // ...
};
```

### Adjust Reply Frequency
Currently: Max 1 reply per webhook event
To limit daily: Track in `src/db.js`

### Add Custom Filters
Edit `src/filters.js` shouldReplyTo():
```javascript
// Add more conditions
if (!mention.user.followers_count > 5000) return false;
```

---

## Monitoring Alerts

### Set Up Cost Alerts
Anthropic: https://console.anthropic.com/account/billing
- Set daily budget: $1.00
- Get email alert if exceeded

Twitter: https://developer.twitter.com/en/account/billing
- Similar alerts available

### Health Check Monitoring
Use uptime monitor service:
```bash
curl https://uptimerobot.com/api

# Add check: GET https://your-url.com/health
# Should respond with {"status":"ok"}
```

---

## Maintenance

### Weekly
- Check analytics dashboard: `npm run monitor`
- Review top authors
- Verify costs are as expected
- Check for errors in analytics.jsonl

### Monthly
- Review engagement quality
- Check if filtering rules need adjustment
- Plan content backlog for broadcaster

### Quarterly
- Performance review
- Consider scaling to more accounts
- Plan new features

---

## Support

### Documentation
- README.md - Overview
- SETUP.md - Initial setup
- DEPLOYMENT-STEPS.md - Step-by-step deploy
- This file - Production reference

### Troubleshooting
1. Check logs: `tail -f analytics.jsonl`
2. Check dashboard: `npm run monitor`
3. Check endpoints: `/health`, `/stats`
4. Review error handler output

---

## Status

✅ **Production Ready**
✅ **Error Handling Complete**
✅ **Monitoring Dashboard Included**
✅ **Analytics Tracking Live**
✅ **Cost Transparent**
✅ **Ready for 24/7 Operation**

Deploy now! 🚀
