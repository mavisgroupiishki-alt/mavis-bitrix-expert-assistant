const express = require('express');
const path = require('path');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Bitrix opens local apps in iframe. Disable frameguard but keep other sane defaults.
app.use(
  helmet({
    frameguard: false,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseIdList(value) {
  return (value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const config = {
  leaderUserIds: parseIdList(process.env.LEADER_USER_IDS),
  adminUserIds: parseIdList(process.env.ADMIN_USER_IDS),
  ropUserIds: parseIdList(process.env.ROP_USER_IDS),
  productionCategoryId: process.env.PRODUCTION_CATEGORY_ID || '',
  maxDeals: Number(process.env.MAX_DEALS || 30),
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mavis-bitrix-expert-assistant' });
});

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
});

// Main app page used as "Путь вашего обработчика" in Bitrix24.
app.all(['/', '/app'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Installation page used as "Путь для первоначальной установки" in Bitrix24.
// For first MVP we complete installation from the iframe via BX24.installFinish().
app.all('/install', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

app.listen(PORT, () => {
  console.log(`MAVIS Bitrix Expert Assistant is running on port ${PORT}`);
});
