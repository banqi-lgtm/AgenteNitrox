require('dotenv').config();
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const { generateMateoResponse, admin } = require('./agent');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'btnt_nitrox_secret_token_2026';

const processedMessageIds = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isMessageAlreadyProcessed(messageId) {
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 2000) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }
  try {
    const docRef = admin.firestore().collection('mensajes_procesados').doc(messageId);
    const doc = await docRef.get();
    if (doc.exists) return true;
    await docRef.set({ timestamp: Date.now() });
  } catch (err) {
    // Non-blocking fallback
  }
  return false;
}

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
    if (data.error) {
      console.error(`❌ [ERROR META ENVIANDO A +${to}]:`, JSON.stringify(data.error));
    }
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
    if (d.error) {
      console.error(`❌ [ERROR META TYPING]:`, JSON.stringify(d.error));
    }
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

  // Prevent duplicate processing on container cold start or Meta retries
  const alreadyProcessed = await isMessageAlreadyProcessed(messageId);
  if (alreadyProcessed) {
    console.log(`⚠️ [DUPLICADO IGNORADO] Mensaje ${messageId} ya fue procesado`);
    return res.status(200).send('EVENT_RECEIVED');
  }

  if (message.type !== 'text') {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const incomingText = message.text.body;
  console.log(`\n📩 [MENSAJE RECIBIDO de +${from}]: "${incomingText}"`);

  try {
    // 1. Send real WhatsApp typing indicator ("escribiendo..." animated dots)
    await sendTypingIndicator(messageId);

    // 2. Natural human pause: 1.5 to 2.2 seconds
    const initialDelay = Math.floor(Math.random() * 700) + 1500;
    console.log(`⏳ [ESCRIBIENDO...] Pausa de ${(initialDelay / 1000).toFixed(1)}s...`);
    await sleep(initialDelay);

    // 3. Generate response bubbles
    const bubbles = await generateMateoResponse(from, incomingText);

    // 4. Send bubbles with smooth natural interval (500ms)
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      console.log(`📤 [MATEO RESPONDE (${i + 1}/${bubbles.length}) a +${from}]: "${bubble}"`);
      await sendWhatsAppMessage(from, bubble);

      if (i < bubbles.length - 1) {
        await sleep(500);
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