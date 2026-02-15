#!/bin/bash

# GRAISONBOT WEBHOOK - AUTOMATED DEPLOYMENT SCRIPT
# Run this to deploy to Railway (or test locally)

set -e

echo "🚀 GRAISONBOT WEBHOOK DEPLOYMENT"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "✓ Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ npm not found${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"
echo -e "${GREEN}✓ npm $(npm -v)${NC}"
echo ""

# Step 1: Install dependencies
echo "📦 Step 1: Installing dependencies..."
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Step 2: Check .env
echo "⚙️  Step 2: Checking configuration..."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo "Creating .env from template..."
    cp .env.example .env
    echo -e "${YELLOW}⚠️  IMPORTANT: Edit .env with your credentials:${NC}"
    echo ""
    echo "  TWITTER_API_KEY=your_key"
    echo "  TWITTER_API_SECRET=your_secret"
    echo "  TWITTER_ACCESS_TOKEN=your_token"
    echo "  TWITTER_ACCESS_TOKEN_SECRET=your_token_secret"
    echo "  ANTHROPIC_API_KEY=your_anthropic_key"
    echo ""
    echo "Then run this script again"
    exit 1
  fi
fi

# Check if .env has values
if grep -q "your_" .env; then
  echo -e "${RED}✗ .env has placeholder values. Edit them first:${NC}"
  echo "  nano .env"
  exit 1
fi

echo -e "${GREEN}✓ .env configured${NC}"
echo ""

# Step 3: Test locally
echo "🧪 Step 3: Testing locally..."
echo "Starting server on http://localhost:3000"
echo "Press Ctrl+C after testing"
echo ""

timeout 10 npm start || true

echo ""
echo -e "${GREEN}✓ Server test complete${NC}"
echo ""

# Step 4: Prompt for deployment method
echo "🌐 Step 4: Deployment method"
echo ""
echo "  1) Railway (recommended - free tier, auto-deploys)"
echo "  2) Keep running locally (ngrok for public URL)"
echo "  3) Skip deployment for now"
echo ""
read -p "Choose (1-3): " choice

case $choice in
  1)
    echo ""
    echo "📤 Railway Deployment:"
    echo ""
    echo "1. Go to https://railway.app and sign up"
    echo "2. Create new project"
    echo "3. Connect GitHub repo"
    echo "4. Add environment variables from .env"
    echo "5. Click Deploy"
    echo ""
    echo "After deployment, you'll get a public URL like:"
    echo "  https://mention-webhook-production.up.railway.app"
    echo ""
    read -p "Enter your Railway URL (or press Enter to skip): " railway_url
    
    if [ ! -z "$railway_url" ]; then
      # Update .env with Railway URL
      sed -i '' "s|^WEBHOOK_URL=.*|WEBHOOK_URL=$railway_url/webhooks/twitter|" .env
      echo -e "${GREEN}✓ WEBHOOK_URL updated${NC}"
      echo ""
      echo "📝 Step 5: Register webhook with Twitter"
      echo ""
      npm run register
    fi
    ;;
  2)
    echo ""
    echo "🔗 Local + ngrok setup:"
    echo ""
    echo "1. Install ngrok: https://ngrok.com/download"
    echo "2. Run: ngrok http 3000"
    echo "3. Copy the URL from ngrok output"
    echo "4. Add to .env: WEBHOOK_URL=https://your-ngrok-url/webhooks/twitter"
    echo "5. Run: npm run register"
    echo "6. Start server: npm start"
    ;;
  3)
    echo "Setup skipped. When ready:"
    echo "  npm start              # Start server"
    echo "  npm run register       # Register webhook"
    echo "  npm run monitor        # View dashboard"
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "${GREEN}✅ DEPLOYMENT READY${NC}"
echo ""
echo "Next steps:"
echo "  1. npm start              # Start the server"
echo "  2. npm run register       # Register webhook (if not done)"
echo "  3. npm run monitor        # Watch live dashboard"
echo ""
echo "Test it:"
echo "  Mention @graisonbot from verified account"
echo "  You should get a reply in 5-10 seconds!"
echo ""
