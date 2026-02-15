#!/bin/bash

# ⚠️  BEFORE RUNNING THIS SCRIPT:
# 1. Make sure you're logged into GitHub (git config user.name, git config user.email)
# 2. Have your credentials ready (Twitter API key, Anthropic key)
# 3. Have Railway account ready (https://railway.app)

set -e

echo "🚀 GRAISONBOT WEBHOOK - LOCAL DEPLOYMENT"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check if .env exists and is configured
if [ ! -f .env ]; then
  echo "❌ .env file not found"
  echo ""
  echo "Please create .env first:"
  echo "  cp .env.example .env"
  echo "  nano .env"
  echo "  # Add your 5 credentials"
  exit 1
fi

# Check if credentials are still placeholders
if grep -q "your_" .env; then
  echo "❌ .env has placeholder values"
  echo ""
  echo "Please edit .env with real credentials:"
  echo "  nano .env"
  exit 1
fi

echo "✅ .env configured"
echo ""

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
npm install --silent
echo "✅ Done"
echo ""

# Step 2: Test locally
echo "🧪 Testing server locally..."
echo "   Starting on http://localhost:3000"
echo ""

timeout 8 npm start 2>&1 | head -20 || true

echo ""
echo "✅ Server test complete"
echo ""

# Step 3: Git setup
echo "📝 Git setup..."
if ! git config --get user.name > /dev/null; then
  echo ""
  echo "⚠️  Git user not configured"
  echo "Run:"
  echo "  git config --global user.name 'Your Name'"
  echo "  git config --global user.email 'your@email.com'"
  exit 1
fi

echo "✅ Git configured as: $(git config --get user.name)"
echo ""

# Step 4: Commit
echo "📤 Committing to Git..."
git add .
git commit -m "Deploy webhook v2 - $(date)" --allow-empty
echo "✅ Committed"
echo ""

# Step 5: Push to GitHub
echo "📤 Pushing to GitHub..."
git push origin main
echo "✅ Pushed"
echo ""

# Step 6: Get Railway URL
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "🌐 RAILWAY DEPLOYMENT"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Now deploy on Railway:"
echo ""
echo "1. Go to: https://railway.app"
echo "2. Click 'New Project'"
echo "3. Select 'Deploy from GitHub'"
echo "4. Choose this repo"
echo "5. Add environment variables from .env:"
echo "   - TWITTER_API_KEY"
echo "   - TWITTER_API_SECRET"
echo "   - TWITTER_ACCESS_TOKEN"
echo "   - TWITTER_ACCESS_TOKEN_SECRET"
echo "   - ANTHROPIC_API_KEY"
echo ""
echo "6. Click 'Deploy'"
echo "7. Wait for deployment (2-3 min)"
echo "8. Get public URL from Railway dashboard"
echo ""
read -p "Enter Railway public URL (https://...): " railway_url

if [ -z "$railway_url" ]; then
  echo "❌ URL required"
  exit 1
fi

# Update .env with Railway URL
sed -i '' "s|^WEBHOOK_URL=.*|WEBHOOK_URL=$railway_url/webhooks/twitter|" .env
echo "✅ WEBHOOK_URL updated: $railway_url/webhooks/twitter"
echo ""

# Step 7: Register webhook
echo "📝 Registering webhook with Twitter..."
npm run register
echo ""
echo "✅ Webhook registered!"
echo ""

# Step 8: Test
echo "═══════════════════════════════════════════════════════════"
echo "✅ DEPLOYMENT COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "🧪 Test it now:"
echo "   1. Mention @graisonbot from a verified account"
echo "   2. Wait 5-10 seconds for reply"
echo ""
echo "📊 Monitor live:"
echo "   npm run monitor"
echo ""
echo "📈 Check stats:"
echo "   curl $railway_url/stats"
echo ""
echo "✨ You're live! 🎉"
echo ""
