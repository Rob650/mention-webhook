/**
 * Logger - Console output with levels and formatting
 */

const LogLevel = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

function formatTimestamp() {
  return new Date().toISOString();
}

function formatLog(level, message, data = null) {
  const timestamp = formatTimestamp();
  const emoji = {
    ERROR: '❌',
    WARN: '⚠️',
    INFO: 'ℹ️',
    DEBUG: '🔍'
  }[level] || '•';

  let output = `${emoji} [${timestamp}] [${level}] ${message}`;
  if (data) {
    output += ` ${JSON.stringify(data)}`;
  }
  return output;
}

export const logger = {
  error: (message, data) => {
    console.error(formatLog(LogLevel.ERROR, message, data));
  },

  warn: (message, data) => {
    console.warn(formatLog(LogLevel.WARN, message, data));
  },

  info: (message, data) => {
    console.log(formatLog(LogLevel.INFO, message, data));
  },

  debug: (message, data) => {
    if (process.env.DEBUG) {
      console.log(formatLog(LogLevel.DEBUG, message, data));
    }
  },

  mention: (author, text, verified = true) => {
    console.log(`\n💬 ${formatTimestamp()}`);
    console.log(`   @${author}: "${text.substring(0, 70)}..."`);
    console.log(`   Verified: ${verified ? '✓' : '✗'}`);
  },

  reply: (author, replyText) => {
    console.log(`   📝 Reply: "${replyText.substring(0, 60)}..."`);
  },

  success: (message, data) => {
    console.log(`✅ ${formatTimestamp()} ${message}`);
    if (data) {
      console.log(`   ${JSON.stringify(data)}`);
    }
  },

  cost: (item, cost) => {
    console.log(`💰 ${item}: $${cost.toFixed(3)}`);
  }
};
