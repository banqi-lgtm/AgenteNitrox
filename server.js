require('dotenv').config();
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const { generateMateoResponse } = require('./agent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'btnt_nitrox_secret_token_2026';

const processedMessageIds = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    console.log(`[META ENVIO A +${to}]:`, JSON.stringify(data));
    return data;
  } catch (error) {
    console.error('Error enviando mensaje a', to, error);
  }
}

// Typing indicator ("escribiendo..." with 3 animated dots) & read receipt
async function sendTypingIndicator(messageId) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: {
          type: 'text'
        }
      })
    });
    const d = await res.json();
    console.log(`[META TYPING INDICATOR]:`, JSON.stringify(d));
  } catch (err) {
    // ignore
  }
}

// 1. Webhook Verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verificado exitosamente con Meta!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.send('Servidor WhatsApp Agente Mateo (NITROX) activo 🚀');
});

// 2. Incoming Messages Webhook (POST)
async function handleIncomingMessage(req, res) {
  const body = req.body;
  if (!body.entry || !body.entry[0].changes) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const change = body.entry[0].changes[0].value;
  if (!change.messages || change.messages.length === 0) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const message = change.messages[0];
  const messageId = message.id;
  const from = message.from;

  if (processedMessageIds.has(messageId)) {
    return res.status(200).send('EVENT_RECEIVED');
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 2000) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }

  if (message.type !== 'text') {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const incomingText = message.text.body;
  console.log(`\n📩 [MENSAJE RECIBIDO de +${from}]: "${incomingText}"`);

  try {
    // 1. Send real WhatsApp typing indicator ("escribiendo...")
    await sendTypingIndicator(messageId);

    // 2. Fast human delay: 1.5 to 2.5 seconds
    const initialDelay = Math.floor(Math.random() * 1000) + 1500;
    console.log(`⏳ [ESCRIBIENDO...] Pausa de ${(initialDelay / 1000).toFixed(1)}s...`);
    await sleep(initialDelay);

    // 3. Generate response bubbles
    const bubbles = await generateMateoResponse(from, incomingText);

    // 4. Send bubbles with short interval
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      console.log(`📤 [MATEO RESPONDE (${i + 1}/${bubbles.length}) a +${from}]: "${bubble}"`);
      await sendWhatsAppMessage(from, bubble);

      if (i < bubbles.length - 1) {
        await sleep(1000);
      }
    }
    console.log(`✅ [RESPUESTA COMPLETADA para +${from}]\n`);
  } catch (err) {
    console.error('Error procesando mensaje:', err);
  }

  return res.status(200).send('EVENT_RECEIVED');
}

app.post('/webhook', handleIncomingMessage);
app.post('/', handleIncomingMessage);

exports.webhook = onRequest({ cors: true, invoker: 'public' }, app);

if (!process.env.FUNCTION_TARGET) {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor Mateo NITROX activo en el puerto ${PORT}`);
  });
}