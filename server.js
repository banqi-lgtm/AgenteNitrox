require('dotenv').config();
const express = require('express');
const functions = require('firebase-functions/v2/https');
const { generateMateoResponse } = require('./agent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'btnt_nitrox_secret_token_2026';

const processedMessageIds = new Set();
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

// Also support root path GET for Firebase Functions direct webhook URL
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Root verified successfully with Meta!');
    return res.status(200).send(challenge);
  }
  res.send('Servidor WhatsApp Agente Mateo (Talleres NITROX) activo en Firebase 🚀');
});

// 2. Incoming Messages Webhook (POST)
async function handleIncomingMessage(req, res) {
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (!body.entry || !body.entry[0].changes) return;

  const change = body.entry[0].changes[0].value;
  if (!change.messages || change.messages.length === 0) {
    return;
  }

  const message = change.messages[0];
  const messageId = message.id;
  const from = message.from;

  if (processedMessageIds.has(messageId)) {
    return;
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }

  if (message.type !== 'text') {
    return;
  }

  const incomingText = message.text.body;
  console.log(`\n📩 [MENSAJE RECIBIDO de +${from}]: "${incomingText}"`);

  // Human typing simulation:
  await markMessageAsRead(messageId);

  const initialDelay = Math.floor(Math.random() * 2000) + 5000;
  console.log(`⏳ [MATEO ESCRIBIENDO...] Espera de ${(initialDelay / 1000).toFixed(1)}s...`);
  await sleep(initialDelay);

  const bubbles = await generateMateoResponse(from, incomingText);

  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    console.log(`📤 [MATEO RESPONDE (${i + 1}/${bubbles.length})]: "${bubble}"`);
    await sendWhatsAppMessage(from, bubble);

    if (i < bubbles.length - 1) {
      const bubbleDelay = Math.floor(Math.random() * 1500) + 2000;
      await sleep(bubbleDelay);
    }
  }
  console.log('✅ [RESPUESTA COMPLETADA]\n');
}

app.post('/webhook', handleIncomingMessage);
app.post('/', handleIncomingMessage);

// Export for Firebase Cloud Functions (24/7 serverless execution)
exports.webhook = functions.onRequest({ cors: true, invoker: 'public' }, app);

// Start locally if executed directly
if (process.env.NODE_ENV !== 'production' || !process.env.FUNCTION_TARGET) {
  app.listen(PORT, () => {
    console.log(`======================================================`);
    console.log(`🚀 Servidor Mateo NITROX activo en el puerto ${PORT}`);
    console.log(`👉 Token de verificación de Webhook: ${VERIFY_TOKEN}`);
    console.log(`======================================================`);
  });
}
