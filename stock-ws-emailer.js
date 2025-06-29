const express = require('express');
const http = require('http');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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

// Store subscriptions with selected items
const subscriptions = new Map(); // Map<email, { seeds: Set<item_id>, gear: Set<item_id> }>

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

function buildStockHtmlEmail(data, recipientEmail) {
  const userSelections = subscriptions.get(recipientEmail);
  if (!userSelections) return null;

  let html = `<h2>Grow A Garden Stock Update</h2>`;
  const allowedCategories = ['seed_stock', 'gear_stock'];
  let hasItems = false;

  for (const category of allowedCategories) {
    if (!Array.isArray(data[category])) continue;
    const isSeeds = category === 'seed_stock';
    const selectedItems = isSeeds ? userSelections.seeds : userSelections.gear;
    const inStockItems = data[category].filter(item => selectedItems.has(item.item_id) && item.quantity > 0);

    if (inStockItems.length === 0) continue;

    hasItems = true;
    html += `<h3 style="color:#2f4f2f; text-transform: capitalize; border-bottom: 2px solid #6a9955;">${category.replace(/_/g, ' ')}</h3>`;
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
  html += `<p style="font-size: 12px; color: #666;"><a href="http://botemail-wrdo.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}">Unsubscribe</a></p>`;
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
  html += `<p style="font-size: 12px; color: #666;"><a href="http://botemail-wrdo.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}">Unsubscribe</a></p>`;
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

app.get('/', (req, res) => {
  // Categorize items into seeds and gear based on item-info API
  const seedItems = itemInfo ? itemInfo.filter(item => 
    ['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythical', 'Divine', 'Prismatic'].includes(item.rarity) &&
    !['sprinkler', 'tool', 'crate', 'sign', 'fence', 'pillar', 'statue', 'bench', 'table', 'arbour', 'canopy', 'flooring', 'lantern', 'pottery', 'umbrella', 'walkway', 'torch', 'flag', 'well', 'gnome', 'scarecrow', 'trough', 'barrel', 'fountain', 'painting', 'podium', 'rug', 'mailbox', 'gate', 'chime', 'trowel', 'shovel', 'rake', 'wheelbarrow', 'compost', 'cooking', 'clothesline', 'bird', 'log', 'rock', 'hay', 'brick', 'seesaw', 'swing', 'trampoline', 'roundabout', 'lamp', 'tv', 'lightning', 'radar', 'staff'].some(keyword => item.display_name.toLowerCase().includes(keyword))
  ) : [];
  const gearItems = itemInfo ? itemInfo.filter(item => !seedItems.includes(item)) : [];

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
    .popup-content select {
      width: 100%;
      padding: 0.5rem;
      background: #333;
      color: #d4d4d4;
      border: 1px solid #6a9955;
      margin-bottom: 1rem;
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
        <div id="seeds-section">
          <h3>Seeds</h3>
          <div class="item-list">
            ${seedItems.map(item => `
              <label><input type="checkbox" name="seeds" value="${item.item_id}"> ${item.display_name}</label>
            `).join('')}
          </div>
        </div>
        <button type="button" onclick="showGear()">Save and Continue</button>
      </form>
      <div id="gear-section" style="display:none;">
        <h3>Gear</h3>
        <div class="item-list">
          ${gearItems.map(item => `
            <label><input type="checkbox" name="gear" value="${item.item_id}"> ${item.display_name}</label>
          `).join('')}
        </div>
        <button type="submit" form="item-selection-form">Subscribe</button>
        <p id="error-message" class="error"></p>
      </div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const terminal = document.getElementById('terminal');
    const socket = io();
    const subscribeForm = document.getElementById('subscribe-form');
    const popup = document.getElementById('subscribe-popup');
    const seedsSection = document.getElementById('seeds-section');
    const gearSection = document.getElementById('gear-section');
    const itemForm = document.getElementById('item-selection-form');
    const popupEmail = document.getElementById('popup-email');
    const errorMessage = document.getElementById('error-message');

    socket.on('log', msg => {
      terminal.textContent += msg + '\\n';
      terminal.scrollTop = terminal.scrollHeight;
    });

    function showGear() {
      const seedCheckboxes = document.querySelectorAll('input[name="seeds"]:checked');
      if (seedCheckboxes.length === 0) {
        errorMessage.textContent = 'Please select at least one seed item.';
        return;
      }
      errorMessage.textContent = '';
      seedsSection.style.display = 'none';
      gearSection.style.display = 'block';
    }

    subscribeForm.onsubmit = function(e) {
      e.preventDefault();
      const email = subscribeForm.querySelector('input[name="email"]').value.trim();
      if (!email) {
        document.getElementById('subscribe-message').textContent = 'Email cannot be empty.';
        return;
      }
      popupEmail.value = email;
      popup.style.display = 'block';
    };

    itemForm.onsubmit = function(e) {
      const seedCheckboxes = document.querySelectorAll('input[name="seeds"]:checked');
      const gearCheckboxes = document.querySelectorAll('input[name="gear"]:checked');
      if (seedCheckboxes.length === 0 && gearCheckboxes.length === 0) {
        e.preventDefault();
        errorMessage.textContent = 'Please select at least one item.';
      }
    };

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('subscribed')) {
      document.getElementById('subscribe-message').textContent = 'Successfully subscribed!';
    } else if (urlParams.get('unsubscribed')) {
      document.getElementById('subscribe-message').textContent = 'Successfully unsubscribed!';
    } else if (urlParams.get('error')) {
      document.getElementById('subscribe-message').textContent = decodeURIComponent(urlParams.get('error'));
    }
  </script>
</body>
</html>
  `);
});

app.post('/subscribe', (req, res) => {
  const email = req.body.email ? req.body.email.trim() : '';
  if (!email) {
    return res.redirect('/?error=' + encodeURIComponent('Email cannot be empty.'));
  }
  if (subscriptions.has(email)) {
    return res.redirect('/?error=' + encodeURIComponent('Email already subscribed.'));
  }

  const seeds = Array.isArray(req.body.seeds) ? req.body.seeds : req.body.seeds ? [req.body.seeds] : [];
  const gear = Array.isArray(req.body.gear) ? req.body.gear : req.body.gear ? [req.body.gear] : [];

  if (seeds.length === 0 && gear.length === 0) {
    return res.redirect('/?error=' + encodeURIComponent('Please select at least one item.'));
  }

  subscriptions.set(email, {
    seeds: new Set(seeds),
    gear: new Set(gear)
  });
  broadcastLog(`New subscriber: ${email} with ${seeds.length} seeds and ${gear.length} gear selected`);
  res.redirect('/?subscribed=true');
});

app.get('/unsub', (req, res) => {
  const email = req.query.email;
  if (!email || !subscriptions.has(email)) {
    return res.redirect('/?error=' + encodeURIComponent('Email not found in subscription list.'));
  }
  subscriptions.delete(email);
  broadcastLog(`Unsubscribed: ${email}`);
  res.redirect('/?unsubscribed=true');
});

app.get('/test', (req, res) => {
  if (!latestStockDataObj && !latestWeatherDataObj) {
    return res.status(404).send('No data available to send.');
  }
  if (latestStockDataObj) {
    subscriptions.forEach((selections, email) => {
      const html = buildStockHtmlEmail(latestStockDataObj, email);
      if (html) {
        sendEmail('🌱 Grow A Garden Stock Updated!', html, email);
      }
    });
  }
  if (latestWeatherDataObj && latestWeatherDataObj.weather) {
    const activeEvent = latestWeatherDataObj.weather.find(w => w.active);
    if (activeEvent) {
      subscriptions.forEach((_, email) => {
        sendEmail(`🌦️ Grow A Garden Weather Event: ${activeEvent.weather_name}`, 
                 buildWeatherHtmlEmail(activeEvent, latestWeatherDataObj.discord_invite, email), email);
      });
    }
  }
  res.send('Test emails were sent for selected spam items.');
});

server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
