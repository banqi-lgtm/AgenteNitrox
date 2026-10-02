require('dotenv').config();
const express = require('express');
const { generateMateoResponse } = require('./agent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'btnt_nitrox_secret_token_2026';

// Track processed messages to avoid duplicate processing on Meta retries
const processedMessageIds = new Set();

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Send a WhatsApp message
async function sendWhatsAppMessage(to, text) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      })
    });
    const data = await res.json();
    return data;
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Mark message as read
async function markMessageAsRead(messageId) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      })
    });
  } catch (err) {
    // Ignore read mark errors
  }
}

// 1. Meta Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified successfully with Meta!');
    return res.status(200).send(challenge);
  } else {
    console.warn('[WEBHOOK] Verification failed. Expected token:', VERIFY_TOKEN, 'Received:', token);
    return res.sendStatus(403);
  }
});

// 2. Incoming Messages Webhook (POST)
app.post('/webhook', async (req, res) => {
  // Respond immediately with 200 OK so Meta doesn't retry or timeout
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (!body.entry || !body.entry[0].changes) return;

  const change = body.entry[0].changes[0].value;
  if (!change.messages || change.messages.length === 0) {
    // Status update (delivered, read, sent), not an incoming message
    return;
  }

  const message = change.messages[0];
  const messageId = message.id;
  const from = message.from; // Phone number without +

  if (processedMessageIds.has(messageId)) {
    return;
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }

  if (message.type !== 'text') {
    console.log(`[INFO] Received non-text message (${message.type}) from ${from}`);
    return;
  }

  const incomingText = message.text.body;
  console.log(`\n📩 [MENSAJE RECIBIDO de +${from}]: "${incomingText}"`);

  // Human behavior simulation:
  // 1. Mark as read immediately (shows blue checks to user)
  await markMessageAsRead(messageId);

  // 2. Wait between 5 and 7 seconds (reading & thinking delay)
  const initialDelay = Math.floor(Math.random() * 2000) + 5000; // 5000ms - 7000ms
  console.log(`⏳ [MATEO ESCRIBIENDO...] Espera humana de ${(initialDelay / 1000).toFixed(1)} segundos...`);
  await sleep(initialDelay);

  // 3. Generate response bubbles
  const bubbles = await generateMateoResponse(from, incomingText);

  // 4. Send each bubble with human-like intervals (2 - 3.5 seconds)
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    console.log(`📤 [MATEO RESPONDE (${i + 1}/${bubbles.length})]: "${bubble}"`);
    await sendWhatsAppMessage(from, bubble);

    // If there is another bubble, wait between 2 and 3.5 seconds
    if (i < bubbles.length - 1) {
      const bubbleDelay = Math.floor(Math.random() * 1500) + 2000;
      await sleep(bubbleDelay);
    }
  }
  console.log('✅ [RESPUESTA COMPLETADA]\n');
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Agente Mateo (Talleres Nitrot) activo 🚀');
});

app.listen(PORT, () => {
  console.log(`======================================================`);
  console.log(`🚀 Servidor Mateo iniciado en el puerto ${PORT}`);
  console.log(`👉 Token de verificación de Webhook: ${VERIFY_TOKEN}`);
  console.log(`======================================================`);
});
