#!/usr/bin/env node

/**
 * MONITORING DASHBOARD
 * 
 * View real-time stats and analytics
 * Usage: node monitor.js
 */

import { Analytics } from './src/analytics.js';
import { getStats } from './src/db.js';

function printBanner() {
  console.clear();
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║         GRAISONBOT WEBHOOK MONITOR             ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
}

function formatStats(stats, title) {
  console.log(`📊 ${title}`);
  console.log(`   Mentions received:  ${stats.mentions}`);
  console.log(`   Replies sent:       ${stats.replies}`);
  console.log(`   Errors:             ${stats.errors}`);
  console.log(`   Cost:               ${stats.cost}`);
  console.log('');
}

function formatDatabase(stats) {
  console.log('📦 DATABASE STATS');
  console.log(`   Total replies:      ${stats.total_replies}`);
  console.log(`   Unique users:       ${stats.unique_users}`);
  console.log(`   Last reply:         ${stats.last_reply || 'Never'}`);
  console.log('');
}

function formatTopAuthors(authors) {
  if (authors.length === 0) {
    console.log('👥 TOP AUTHORS: None yet');
    console.log('');
    return;
  }

  console.log('👥 TOP AUTHORS (most replied to)');
  authors.forEach((author, idx) => {
    console.log(`   ${idx + 1}. @${author.author} (${author.replies} replies)`);
  });
  console.log('');
}

function formatCostProjection(dailyStats) {
  const matches = dailyStats.cost.match(/\$(.+)/);
  const dailyCost = parseFloat(matches?.[1] || '0');

  console.log('💰 COST PROJECTION');
  console.log(`   Today:              ${dailyStats.cost}`);
  console.log(`   Weekly:             $${(dailyCost * 7).toFixed(2)}`);
  console.log(`   Monthly:            $${(dailyCost * 30).toFixed(2)}`);
  console.log(`   Yearly:             $${(dailyCost * 365).toFixed(2)}`);
  console.log('');
}

async function display() {
  try {
    printBanner();

    console.log(`⏰ ${new Date().toLocaleString()}`);
    console.log('');

    // Get all stats
    const dailyStats = Analytics.getDailyStats();
    const weeklyStats = Analytics.getWeeklyStats();
    const dbStats = await getStats();
    const topAuthors = Analytics.getTopAuthors(5);

    // Format output
    formatStats(dailyStats, '24h STATS');
    formatStats(weeklyStats, '7d STATS');
    formatDatabase(dbStats);
    formatTopAuthors(topAuthors);
    formatCostProjection(dailyStats);

    console.log('🔄 Refreshing in 30 seconds...');
    console.log('Press Ctrl+C to exit');

  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
}

// Initial display
display();

// Refresh every 30 seconds
setInterval(display, 30000);
