const fs = require('fs');

const token = 'EAA5oc1QOZB5gBSn5ZAcyZALvcZAVWL9jxN0LAkZB0uj3SziUNv4KE7yYaPG5pVYO4CJEwfOAZAakGntZCefZCxSUS90p5GohS8X4gMiRDu1i7bpmYkBGAKR2XZCUK6fZChgv1YUoZBYgFjAZBf9WUa8mPtjvWg0ZChZA0UIru261Qj9x4zEX0nUFGEDqTZAOBWry6esEQZDZD';
const phoneId = '1217186421467657';
const recipient = '573208185796';

async function send() {
  console.log('Sending message to ' + recipient + ' from phoneId ' + phoneId);
  const res = await fetch('https://graph.facebook.com/v21.0/' + phoneId + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body: '¡Hola! Conexión exitosa con la API de Meta WhatsApp y tu Agente IA.' }
    })
  });
  
  const data = await res.json();
  console.log('Response:', JSON.stringify(data, null, 2));
}

send().catch(console.error);
