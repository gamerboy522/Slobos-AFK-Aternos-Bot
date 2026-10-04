const net = require('net');
const settings = require('./settings.json');

let reconnectAttempts = 0;
const baseDelay = settings.utils?.['auto-reconnect-delay'] || 5000;
const maxDelay = settings.utils?.['max-reconnect-delay'] || 120000;
const maxAttempts = settings.utils?.['max-reconnect-attempts'] || 20;

// Exponential backoff + random jitter to prevent sync-spam
function getDelay() {
  const exp = baseDelay * Math.pow(2, reconnectAttempts);
  const capped = Math.min(exp, maxDelay);
  return capped + Math.floor(Math.random() * 2000);
}

// Don't retry on permanent/server-enforced disconnects
function shouldReconnect(reason) {
  const r = String(reason).toLowerCase();
  const blocklist = [
    'banned', 'kicked', 'invalid session', 'authentication',
    'outdated client', 'outdated server', 'whitelist', 'full',
    'logged in from another location', 'illegal characters'
  ];
  return !blocklist.some(k => r.includes(k));
}

// Clean teardown to prevent memory leaks & ghost listeners
function cleanupBot(bot) {
  if (!bot) return;
  bot.removeAllListeners();
  try { bot.end('reconnecting'); } catch {}
}

// Lightweight TCP ping to wait for Aternos boot without extra dependencies
function waitForServer(host, port, timeout = 180000) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (Date.now() - start > timeout) return resolve(false);
      const socket = new net.Socket();
      socket.setTimeout(3000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => { socket.destroy(); setTimeout(check, 5000); });
      socket.connect(port, host);
    };
    check();
  });
}

module.exports = function setupReconnect(bot, createBotFn) {
  bot.on('end', async (reason) => {
    console.log(`🔌 [Reconnect] Disconnected: ${reason}`);
    
    if (!shouldReconnect(reason)) {
      console.log('❌ [Reconnect] Permanent disconnect reason. Stopping retries.');
      return;
    }

    if (reconnectAttempts >= maxAttempts) {
      console.log('❌ [Reconnect] Max attempts reached. Exiting.');
      process.exit(0);
    }

    reconnectAttempts++;
    const delay = getDelay();
    console.log(`⏳ [Reconnect] Waiting ${Math.round(delay/1000)}s before retry ${reconnectAttempts}/${maxAttempts}...`);

    cleanupBot(bot);

    // Wait for delay, then check if server is actually online (handles Aternos boot time)
    setTimeout(async () => {
      console.log('📡 [Reconnect] Pinging server...');
      const online = await waitForServer(settings.server.ip, settings.server.port, 120000);
      
      if (!online) {
        console.log('⚠️ [Reconnect] Server still offline. Extending wait...');
        setTimeout(() => createBotFn(), 30000);
        return;
      }

      console.log('✅ [Reconnect] Server online. Connecting...');
      createBotFn();
    }, delay);
  });

  bot.on('login', () => {
    console.log('✅ [Reconnect] Successfully logged in. Resetting attempt counter.');
    reconnectAttempts = 0;
  });
};
