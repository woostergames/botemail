const express = require('express');
const http = require('http');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const crypto = require('crypto');

const stockURL = 'https://api.joshlei.com/v2/growagarden/stock';
const weatherURL = 'https://api.joshlei.com/v2/growagarden/weather';
const itemInfoURL = 'https://api.joshlei.com/v2/growagarden/info/';

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('ERROR: Set EMAIL_USER and EMAIL_PASS env vars.');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

let latestStockDataJSON = null;
let latestStockDataObj = null;
let latestWeatherDataJSON = null;
let latestWeatherDataObj = null;
let itemInfo = null;

// Store pending verifications and subscriptions
const pendingVerifications = new Map(); // Map<email, { token: string, timestamp: number }>
const subscriptions = new Map(); // Map<email, Set<item_id>>

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// Fetch item info on startup
async function fetchItemInfo() {
  try {
    const response = await fetch(itemInfoURL);
    itemInfo = await response.json();
    broadcastLog('Fetched item info from API.');
  } catch (err) {
    broadcastLog(`Error fetching item info: ${err.toString()}`);
  }
}

fetchItemInfo();

function broadcastLog(msg) {
  const timestamp = new Date().toISOString();
  const fullMsg = `[${timestamp}] ${msg}`;
  console.log(fullMsg);
  io.emit('log', fullMsg);
}

function hasDataChanged(oldJSON, newJSON) {
  return oldJSON !== newJSON;
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildVerificationEmail(email, token) {
  const verificationUrl = `https://botemail-yco2.onrender.com/verify?email=${encodeURIComponent(email)}&token=${token}`;
  return `
    <h2>Grow A Garden Subscription Verification</h2>
    <p>Please verify your email address to subscribe to Grow A Garden updates.</p>
    <p><a href="${verificationUrl}" style="padding: 10px 20px; background: #6a9955; color: #fff; text-decoration: none; border-radius: 5px;">Verify and Subscribe</a></p>
    <p>If you did not request this, please ignore this email.</p>
    <p style="font-size: 12px; color: #666;">This link will expire in 24 hours.</p>
  `;
}

function sendVerificationEmail(email) {
  const token = generateVerificationToken();
  const timestamp = Date.now();
  pendingVerifications.set(email, { token, timestamp });

  const mailOptions = {
    from: `"Grow A Garden Bot" <${EMAIL_USER}>`,
    to: email,
    subject: '🌱 Verify Your Grow A Garden Subscription',
    html: buildVerificationEmail(email, token),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      broadcastLog(`Error sending verification email to ${email}: ${error.toString()}`);
    } else {
      broadcastLog(`Verification email sent to ${email}: ${info.response}`);
    }
  });
}

function buildStockHtmlEmail(data, recipientEmail) {
  const userSelections = subscriptions.get(recipientEmail);
  if (!userSelections) return null;

  let html = `<h2>Grow A Garden Stock Update</h2>`;
  let hasItems = false;

  // Aggregate all stock items from API
  const allStockItems = [];
  ['seed_stock', 'gear_stock', 'egg_stock', 'cosmetic_stock', 'event_stock'].forEach(category => {
    if (Array.isArray(data[category])) {
      allStockItems.push(...data[category]);
    }
  });

  const inStockItems = allStockItems.filter(item => userSelections.has(item.item_id) && item.quantity > 0);

  if (inStockItems.length > 0) {
    hasItems = true;
    html += `<table style="border-collapse: collapse; width: 100%; max-width: 600px;">`;
    html += `<thead><tr><th style="border: 1px solid #ddd; padding: 8px;">Icon</th><th style="border: 1px solid #ddd; padding: 8px;">Item</th><th style="border: 1px solid #ddd; padding: 8px;">Quantity</th></tr></thead><tbody>`;
    inStockItems.forEach(item => {
      const name = item.display_name || item.item_id || 'Unknown';
      const qty = item.quantity || 0;
      const iconUrl = itemInfo.find(info => info.item_id === item.item_id)?.icon || `https://api.joshlei.com/v2/growagarden/image/${item.item_id}`;
      html += `<tr><td style="border: 1px solid #ddd; padding: 8px; text-align: center;"><img src="${iconUrl}" alt="${name}" style="width: 32px; height: 32px; object-fit: contain;"></td><td style="border: 1px solid #ddd; padding: 8px;">${name}</td><td style="border: 1px solid #ddd; padding: 8px; text-align: right;">${qty}</td></tr>`;
    });
    html += `</tbody></table><br/>`;
  }

  if (!hasItems) return null;

  html += `<p>Received update from Grow A Garden API feed.</p>`;
  html += `<p style="font-size: 12px; color: #666;"><a href="https://botemail-yco2.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}">Unsubscribe</a></p>`;
  return html;
}

function buildWeatherHtmlEmail(weatherEvent, discordInvite, recipientEmail) {
  const duration = weatherEvent.duration ? `${Math.floor(weatherEvent.duration / 60)} minutes` : 'Unknown';
  let html = `<h2>Grow A Garden Weather Event</h2>`;
  html += `<p><strong>Weather Event:</strong> ${weatherEvent.weather_name || weatherEvent.weather_id || 'Unknown'}</p>`;
  html += `<p><strong>Duration:</strong> ${duration}</p>`;
  if (discordInvite) {
    html += `<p><strong>Join the Community:</strong> <a href="${discordInvite}">Discord Invite</a></p>`;
  }
  html += `<p>New weather event detected in Grow A Garden!</p>`;
  html += `<p style="font-size: 12px; color: #666;"><a href="https://botemail-yco2.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}">Unsubscribe</a></p>`;
  return html;
}

function sendEmail(subject, htmlBody, recipientEmail) {
  const mailOptions = {
    from: `"Grow A Garden Bot" <${EMAIL_USER}>`,
    to: recipientEmail,
    subject: subject,
    html: htmlBody,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      broadcastLog(`Error sending email to ${recipientEmail}: ${error.toString()}`);
    } else {
      broadcastLog(`Email sent to ${recipientEmail}: ${info.response}`);
    }
  });
}

async function pollStockAPI() {
  try {
    const response = await fetch(stockURL);
    const data = await response.json();
    const newDataJSON = JSON.stringify(data);

    if (hasDataChanged(latestStockDataJSON, newDataJSON)) {
      broadcastLog('Stock data changed — checking subscriber selections...');
      latestStockDataJSON = newDataJSON;
      latestStockDataObj = data;
      subscriptions.forEach((selections, email) => {
        const html = buildStockHtmlEmail(data, email);
        if (html) {
          sendEmail('🌱 Grow A Garden Stock Updated!', html, email);
        }
      });
    } else {
      broadcastLog('Polled Stock API — no changes detected.');
    }
  } catch (err) {
    broadcastLog(`Error polling Stock API: ${err.toString()}`);
  }
}

async function pollWeatherAPI() {
  try {
    const response = await fetch(weatherURL);
    const data = await response.json();
    const newDataJSON = JSON.stringify(data);

    if (hasDataChanged(latestWeatherDataJSON, newDataJSON)) {
      broadcastLog('Weather data changed — checking for active events...');
      const activeEvent = data.weather.find(w => w.active);
      const prevActiveEvent = latestWeatherDataObj ? latestWeatherDataObj.weather.find(w => w.active) : null;

      if (activeEvent && (!prevActiveEvent || activeEvent.weather_id !== prevActiveEvent.weather_id)) {
        broadcastLog(`New active weather event: ${activeEvent.weather_name}`);
        subscriptions.forEach((_, email) => {
          sendEmail(`🌦️ Grow A Garden Weather Event: ${activeEvent.weather_name}`, 
                   buildWeatherHtmlEmail(activeEvent, data.discord_invite, email), email);
        });
      } else if (!activeEvent && prevActiveEvent) {
        broadcastLog(`Weather event ended: ${prevActiveEvent.weather_name}`);
      } else {
        broadcastLog('No new active weather event detected.');
      }

      latestWeatherDataJSON = newDataJSON;
      latestWeatherDataObj = data;
    } else {
      broadcastLog('Polled Weather API — no changes detected.');
    }
  } catch (err) {
    broadcastLog(`Error polling Weather API: ${err.toString()}`);
  }
}

setInterval(pollStockAPI, 15000);
setInterval(pollWeatherAPI, 15000);
pollStockAPI();
pollWeatherAPI();

// Clean up expired verification tokens (older than 24 hours)
setInterval(() => {
  const now = Date.now();
  const expirationTime = 24 * 60 * 60 * 1000; // 24 hours
  for (const [email, { timestamp }] of pendingVerifications) {
    if (now - timestamp > expirationTime) {
      pendingVerifications.delete(email);
      broadcastLog(`Removed expired verification token for ${email}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Grow A Garden - Live Logs</title>
  <style>
    body { background: #1e1e1e; color: #d4d4d4; font-family: monospace; margin: 0; padding: 0; }
    #terminal {
      padding: 1rem;
      height: 70vh;
      overflow-y: auto;
      white-space: pre-wrap;
      background: #121212;
      border: 1px solid #333;
      box-sizing: border-box;
    }
    .subscribe-form {
      text-align: center;
      padding: 1rem;
      background: #1e1e1e;
    }
    .subscribe-form input[type="email"] {
      padding: 0.5rem;
      font-size: 1rem;
      background: #333;
      color: #d4d4d4;
      border: 1px solid #6a9955;
      margin-right: 0.5rem;
    }
    .subscribe-form button {
      padding: 0.5rem 1rem;
      font-size: 1rem;
      background: #6a9955;
      color: #fff;
      border: none;
      cursor: pointer;
    }
    .subscribe-form button:hover {
      background: #4a7a3a;
    }
    .subscribe-form p {
      color: #ff5555;
      margin: 0.5rem 0 0;
    }
    .popup {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
    }
    .popup-content {
      background: #1e1e1e;
      border: 1px solid #6a9955;
      padding: 20px;
      width: 80%;
      max-width: 600px;
      max-height: 80vh;
      overflow-y: auto;
      margin: 10% auto;
      position: relative;
    }
    .popup-content h2 {
      color: #6a9955;
      margin-top: 0;
    }
    .popup-content button {
      background: #6a9955;
      color: #fff;
      border: none;
      padding: 0.5rem 1rem;
      cursor: pointer;
      margin: 1rem 0.5rem 0 0;
    }
    .popup-content button:hover {
      background: #4a7a3a;
    }
    .item-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }
    .item-list label {
      display: block;
      padding: 0.5rem;
      background: #333;
      border: 1px solid #555;
    }
    .error {
      color: #ff5555;
      margin: 0.5rem 0;
    }
  </style>
</head>
<body>
  <h1 style="text-align:center; color:#6a9955;">Grow A Garden Live Terminal Logs</h1>
  <div class="subscribe-form">
    <form id="subscribe-form">
      <input type="email" name="email" placeholder="Enter your email" required>
      <button type="submit">Subscribe</button>
    </form>
    <p id="subscribe-message"></p>
  </div>
  <div id="terminal"></div>

  <div id="subscribe-popup" class="popup">
    <div class="popup-content">
      <h2>Select Items for Stock Alerts</h2>
      <form id="item-selection-form" action="/subscribe" method="POST">
        <input type="hidden" name="email" id="popup-email">
        <div id="items-section">
          <h3>Items</h3>
          <div class="item-list">
            ${itemInfo ? itemInfo.map(item => `
              <label><input type="checkbox" name="items" value="${item.item_id}"> ${item.display_name}</label>
            `).join('') : '<p>Loading items...</p>'}
          </div>
        </div>
        <button type="submit">Subscribe</button>
        <p id="error-message" class="error"></p>
      </form>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const terminal = document.getElementById('terminal');
    const socket = io();
    const subscribeForm = document.getElementById('subscribe-form');
    const popup = document.getElementById('subscribe-popup');
    const itemForm = document.getElementById('item-selection-form');
    const popupEmail = document.getElementById('popup-email');
    const errorMessage = document.getElementById('error-message');

    socket.on('log', msg => {
      terminal.textContent += msg + '\\n';
      terminal.scrollTop = terminal.scrollHeight;
    });

    subscribeForm.onsubmit = async function(e) {
      e.preventDefault();
      const email = subscribeForm.querySelector('input[name="email"]').value.trim();
      if (!email) {
        document.getElementById('subscribe-message').textContent = 'Email cannot be empty.';
        return;
      }

      const response = await fetch('/request-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email })
      });
      const result = await response.json();
      document.getElementById('subscribe-message').textContent = result.message;
      if (result.success) {
        popupEmail.value = email;
        popup.style.display = 'block';
      }
    };

    itemForm.onsubmit = function(e) {
      const itemCheckboxes = document.querySelectorAll('input[name="items"]:checked');
      if (itemCheckboxes.length === 0) {
        e.preventDefault();
        errorMessage.textContent = 'Please select at least one item.';
      }
    };

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('subscribed')) {
      document.getElementById('subscribe-message').textContent = 'Successfully subscribed!';
    } else if (urlParams.get('unsubscribed')) {
      document.getElementById('subscribe-message').textContent = 'Successfully unsubscribed!';
    } else if (urlParams.get('verified')) {
      popupEmail.value = urlParams.get('email');
      popup.style.display = 'block';
    }
  </script>
</body>
</html>
  `);
});

app.post('/request-verification', async (req, res) => {
  const email = req.body.email?.trim();
  if (!email) {
    return res.json({ success: false, message: 'Email is required.' });
  }
  if (subscriptions.has(email)) {
    return res.json({ success: false, message: 'Email is already subscribed.' });
  }
  sendVerificationEmail(email);
  res.json({ success: true, message: 'Verification email sent. Please check your inbox.' });
});

app.get('/verify', (req, res) => {
  const { email, token } = req.query;
  const verification = pendingVerifications.get(email);

  if (!verification || verification.token !== token) {
    return res.send('Invalid or expired verification link.');
  }

  pendingVerifications.delete(email);
  res.redirect(`/?verified=true&email=${encodeURIComponent(email)}`);
});

app.post('/subscribe', (req, res) => {
  const email = req.body.email?.trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body.items].filter(Boolean);

  if (!email || items.length === 0) {
    return res.redirect('/?error=Invalid input');
  }

  subscriptions.set(email, new Set(items));
  broadcastLog(`New subscription: ${email} for ${items.length} items`);
  res.redirect('/?subscribed=true');
});

app.get('/unsub', (req, res) => {
  const email = req.query.email?.trim();
  if (subscriptions.delete(email)) {
    broadcastLog(`Unsubscribed: ${email}`);
    res.redirect('/?unsubscribed=true');
  } else {
    res.send('Email not found in subscriptions.');
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
