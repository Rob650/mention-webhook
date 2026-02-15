#!/bin/bash

# Test webhook locally
# Usage: ./test-webhook.sh

echo "Testing webhook..."
echo ""

# Simulate a mention from verified account
curl -X POST http://localhost:3000/webhooks/twitter \
  -H "Content-Type: application/json" \
  -d '{
    "tweet_create_events": [{
      "id_str": "test_tweet_12345",
      "text": "@graisonbot what do you think about decentralized AI agents? 🤔",
      "user": {
        "id_str": "verified_user_001",
        "screen_name": "crypto_researcher",
        "verified": true,
        "followers_count": 50000
      },
      "created_at": "Mon Feb 15 07:45:00 +0000 2026"
    }]
  }'

echo ""
echo "✅ Test mention sent!"
echo ""
echo "Check response:"
echo "  curl http://localhost:3000/stats"
echo "  curl http://localhost:3000/api/replies?hours=1"
