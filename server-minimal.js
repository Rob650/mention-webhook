#!/usr/bin/env node

import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/stats', (req, res) => {
  res.json({ total_replies: 0, unique_users: 0 });
});

app.listen(PORT, () => {
  console.log(`[MINIMAL] Server listening on port ${PORT}`);
});
