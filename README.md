# Graisonbot Webhook - Real-time Mention Replies

Webhook-based mention reply system for @graisonbot. Real-time responses to verified accounts with zero polling overhead.

```
Cost: $0.28/day (vs $14.40/day with polling)
Response Time: Real-time (no delay)
Replies: 0-5 per day (verified mentions only)
```

---

## Architecture

```
Twitter (mention event)
        ↓
    Webhook POST
        ↓
    Your Server
        ├─ Filter: verified? ✓
        ├─ Dedup: replied recently? ✗
        ├─ Claude Haiku: generate reply ($0.004)
        ├─ Twitter API: post reply ($0.010)
        └─ Database: record reply
```

---

## Quick Setup (2 steps)

### 1. Install & Configure

```bash
cd mention-webhook
npm install
cp .env.example .env

# Edit .env with your credentials:
# TWITTER_API_KEY=...
# ANTHROPIC_API_KEY=...
```

### 2. Deploy to Railway

```bash
# Railway auto-deploys from GitHub
# Just push this code, Railway handles the rest
# Free tier: 5 apps, unlimited bandwidth
```

Get your public URL → Register webhook → Done ✅

---

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

### View Stats
```bash
curl http://localhost:3000/stats
```

Response:
```json
{
  "total_replies": 15,
  "unique_users": 8,
  "costPerReply": "$0.014",
  "estimatedDailyAverage": "$0.28",
  "estimatedMonthly": "$8.40"
}
```

### View Recent Replies
```bash
curl "http://localhost:3000/api/replies?hours=24"
```

---

## Deployment

### Option 1: Railway (Recommended)
- Zero-downtime deployments
- Free tier (5 apps)
- Auto-scaling
- Built-in database support

```bash
# Just push to GitHub, Railway deploys automatically
git push origin main
```

See [SETUP.md](SETUP.md) for detailed Railway instructions.

### Option 2: Your Mac (For Testing)
```bash
npm start
# Server runs on http://localhost:3000
```

Use ngrok for public URL:
```bash
ngrok http 3000
# Exposes as https://xxxx-xx-xxx-xxx.ngrok.io
```

### Option 3: VPS ($5-10/month)
- Self-hosted
- Full control
- Higher uptime

See [SETUP.md](SETUP.md) for deployment guides.

---

## Filtering Rules

The bot only replies to mentions that pass ALL filters:

1. ✅ **Author must be verified** (blue checkmark)
2. ✅ **Must mention @graisonbot** in the text
3. ✅ **Not a retweet** (skip RT @...)
4. ✅ **Not a reply to someone else** (must be original mention)
5. ✅ **Haven't replied to this author in 24h** (dedup)

---

## Cost Analysis

### Per Reply
| Item | Cost |
|------|------|
| Claude Haiku (reply generation) | $0.004 |
| Twitter API (post reply) | $0.010 |
| **Total** | **$0.014** |

### Daily (20 replies from verified accounts)
| Item | Cost |
|------|------|
| Claude: 20 × $0.004 | $0.08 |
| Twitter: 20 × $0.010 | $0.20 |
| **Total** | **$0.28** |

### Comparison vs Polling

| Method | Search | Reply | Total/Day |
|--------|--------|-------|-----------|
| **Webhook** | $0 | $0.28 | **$0.28** ✅ |
| Poll 5min | $14.40 | $0.28 | $14.68 |
| Poll 30min | $2.40 | $0.28 | $2.68 |

**Webhook saves 99.8% vs polling every 5 minutes** 🚀

---

## Monitoring & Logs

### View database
```bash
sqlite3 graisonbot.db "SELECT * FROM mentions ORDER BY timestamp DESC LIMIT 5;"
```

### Watch logs (on Railway)
```bash
railway logs --follow
```

### Check API spend
- **Twitter**: https://developer.twitter.com/en/account/billing
- **Anthropic**: https://console.anthropic.com/account/billing

---

## Files

```
mention-webhook/
├── server.js              # Main Express app + webhook handler
├── src/
│  ├── db.js              # SQLite setup + queries
│  ├── filters.js         # Mention filtering logic
│  └── config.js          # Config (optional)
├── package.json          # Dependencies
├── .env.example          # Environment template
├── SETUP.md              # Detailed setup guide
└── README.md            # This file
```

---

## Troubleshooting

### No mentions received?
1. Check webhook is registered: `curl https://developer.twitter.com/...`
2. Check webhook URL is public: `curl https://your-domain.com/health`
3. Verify filter is active on Twitter Account Activity API
4. Check database: `sqlite3 graisonbot.db "SELECT COUNT(*) FROM mentions;"`

### "Unauthorized" errors?
1. Verify API credentials in .env
2. Check Twitter app permissions (needs write access)
3. Check Anthropic API key is valid

### Replies not posting?
1. Check Twitter API rate limits
2. Verify reply format is valid
3. Check database has entries

---

## Next Steps

1. **Deploy to Railway** (5 min)
2. **Register webhook** (2 min)
3. **Mention @graisonbot** from verified account
4. **Watch replies come in!** 🎉

---

## Support

- 📖 See [SETUP.md](SETUP.md) for detailed instructions
- 🐛 Check troubleshooting section above
- 📊 View stats at `/stats` endpoint
