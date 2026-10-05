require('dotenv').config();
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const path = require('path');
const { generateMateoResponse, admin, localMecanicosStore } = require('./agent');
const { normalizeMechanicData } = require('./scoring');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'btnt_nitrox_secret_token_2026';
const ADMIN_TOKEN = 'nitrox_admin_secret_token_2026';

const processedMessageIds = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Auth Middleware for CRM
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.startsWith('Bearer ')) 
    ? authHeader.split(' ')[1] 
    : (req.query.token || req.headers['x-admin-token']);

  if (token === ADMIN_TOKEN) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'No autorizado. Ingrese con credenciales de administrador.' });
}

// ==========================================
// 1. WEB & CRM ROUTES
// ==========================================
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm.html'));
});

app.get('/admin', (req, res) => {
  res.redirect('/crm');
});

app.get('/formulario', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'formulario.html'));
});

app.get('/registro', (req, res) => {
  res.redirect('/formulario');
});

// Auth API
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === 'administrador@nitrox.com' && password === 'administrador') {
    return res.json({ success: true, token: ADMIN_TOKEN });
  }
  return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos' });
});

// In-memory fallback for local dev / resilience
let localMecanicosCache = localMecanicosStore;

// Formulario Lookup API (Permite al formulario web precargar los datos ya capturados por WhatsApp)
app.get('/api/formulario/lookup', async (req, res) => {
  try {
    const q = req.query.q || req.query.id || req.query.tel;
    if (!q) {
      return res.status(400).json({ success: false, message: 'Parámetro de búsqueda requerido' });
    }

    const cleanQ = q.replace(/\D/g, '');
    let found = (localMecanicosCache || []).find(m => m.id_unico === q || (cleanQ && (m.celular_whatsapp || '').includes(cleanQ)));

    if (!found) {
      try {
        const firestorePromise = (async () => {
          const doc = await admin.firestore().collection('mecanicos_red_nitrox').doc(q).get();
          if (doc.exists) return doc.data();

          const snap = await admin.firestore().collection('mecanicos_red_nitrox').where('id_unico', '==', q).get();
          if (!snap.empty) return snap.docs[0].data();

          if (cleanQ) {
            const snap2 = await admin.firestore().collection('mecanicos_red_nitrox').where('celular_whatsapp', '==', cleanQ).get();
            if (!snap2.empty) return snap2.docs[0].data();
            const altPhone = cleanQ.startsWith('57') ? cleanQ.substring(2) : `57${cleanQ}`;
            const snap3 = await admin.firestore().collection('mecanicos_red_nitrox').where('celular_whatsapp', '==', altPhone).get();
            if (!snap3.empty) return snap3.docs[0].data();
          }
          return null;
        })();

        found = await Promise.race([
          firestorePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);
      } catch (fsErr) {
        console.warn('[LOOKUP TIMEOUT/FALLBACK]', fsErr.message);
      }
    }

    if (found) {
      return res.json({ success: true, mecanico: found });
    }
    return res.status(404).json({ success: false, message: 'Mecánico no encontrado' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Formulario Virtual API (Canal opcional o complementario)
app.post('/api/formulario', async (req, res) => {
  try {
    const rawData = req.body || {};
    if (!rawData.nombres_apellidos || !rawData.celular_whatsapp || !rawData.nombre_taller) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
    }

    // Detectar si complementa un registro previo de WhatsApp
    let existingDoc = null;
    let targetDocId = rawData.id_unico;

    try {
      if (targetDocId) {
        existingDoc = (localMecanicosCache || []).find(m => m.id_unico === targetDocId);
        if (!existingDoc) {
          const snap = await Promise.race([
            admin.firestore().collection('mecanicos_red_nitrox').doc(targetDocId).get(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
          ]);
          if (snap.exists) existingDoc = snap.data();
        }
      }
      if (!existingDoc && rawData.celular_whatsapp) {
        const cleanPhone = rawData.celular_whatsapp.replace(/\D/g, '');
        existingDoc = (localMecanicosCache || []).find(m => (m.celular_whatsapp || '').includes(cleanPhone));
        if (existingDoc) targetDocId = existingDoc.id_unico;
      }
    } catch (e) {
      console.warn('[CHECK EXISTING]', e.message);
    }

    const origin = existingDoc ? 'WhatsApp + Web (Opcional)' : 'Formulario Web';
    const mergedData = { ...(existingDoc || {}), ...rawData };
    if (targetDocId) mergedData.id_unico = targetDocId;

    const normalized = normalizeMechanicData(mergedData, origin);
    const docId = normalized.id_unico;

    const idx = localMecanicosCache.findIndex(m => m.id_unico === docId);
    if (idx >= 0) localMecanicosCache[idx] = normalized;
    else localMecanicosCache.unshift(normalized);

    try {
      admin.firestore().collection('mecanicos_red_nitrox').doc(docId).set(normalized, { merge: true }).catch(e => console.warn('[FIRESTORE BACKGROUND SAVE]', e.message));
      console.log(`[FORMULARIO] Guardado: ${normalized.nombres_apellidos} (ID: ${normalized.id_unico} | Origen: ${origin})`);
    } catch (fsErr) {
      console.warn('[FIRESTORE]', fsErr.message);
    }

    return res.json({ success: true, mecanico: normalized, origen });
  } catch (err) {
    console.error('Error al guardar formulario web:', err);
    return res.status(500).json({ success: false, message: 'Error interno al procesar el registro' });
  }
});

// CRM Mecánicos List API
app.get('/api/crm/mecanicos', requireAuth, async (req, res) => {
  try {
    let list = [];
    try {
      const snapPromise = admin.firestore().collection('mecanicos_red_nitrox').get();
      const snapshot = await Promise.race([
        snapPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
      ]);
      snapshot.forEach(doc => list.push(doc.data()));
    } catch (fsErr) {
      console.warn('[FIRESTORE (fallback local)]', fsErr.message);
    }

    (localMecanicosCache || []).forEach(localItem => {
      if (!list.some(item => item.id_unico === localItem.id_unico)) {
        list.push(localItem);
      }
    });

    list.sort((a, b) => new Date(b.fecha_registro || 0) - new Date(a.fecha_registro || 0));
    return res.json({ success: true, count: list.length, mecanicos: list });
  } catch (err) {
    console.error('Error obteniendo mecánicos:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// CRM Mecánicos Update Level API
app.put('/api/crm/mecanicos/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const { nivel, estado, notas } = req.body || {};
    const updates = {};

    if (nivel !== undefined) {
      updates.nivel_relacion_numero = parseInt(nivel, 10);
      const levelNames = {
        1: 'Registrado',
        2: 'Conoce NITROX',
        3: 'Capacitado',
        4: 'Probó NITROX',
        5: 'Compra NITROX',
        6: 'Usuario recurrente',
        7: 'Recomienda NITROX'
      };
      updates.nivel_relacion_nombre = levelNames[updates.nivel_relacion_numero] || `Nivel ${updates.nivel_relacion_numero}`;
    }
    if (estado) updates.estado_mecanico = estado;
    if (notas) updates.notas_promotor = notas;

    try {
      const docRef = admin.firestore().collection('mecanicos_red_nitrox').doc(id);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        await docRef.update(updates);
      } else {
        const q = await admin.firestore().collection('mecanicos_red_nitrox').where('id_unico', '==', id).get();
        if (!q.empty) {
          await q.docs[0].ref.update(updates);
        }
      }
    } catch (fsErr) {
      const item = localMecanicosCache.find(m => m.id_unico === id || m.celular_whatsapp === id);
      if (item) Object.assign(item, updates);
    }
    return res.json({ success: true, updates });
  } catch (err) {
    console.error('Error actualizando mecánico:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// CRM Export CSV API
app.get('/api/crm/export', requireAuth, async (req, res) => {
  try {
    let list = [];
    try {
      const snapshot = await admin.firestore().collection('mecanicos_red_nitrox').get();
      snapshot.forEach(doc => list.push(doc.data()));
    } catch (fsErr) {
      console.warn('[FIRESTORE (fallback local)]', fsErr.message);
      list = [...localMecanicosCache];
    }
    list.sort((a, b) => new Date(b.fecha_registro || 0) - new Date(a.fecha_registro || 0));

    const headers = [
      'ID Unico', 'Fecha Registro', 'Origen', 'Nivel Numero', 'Nivel Nombre', 'Score Potencial',
      'Nombres y Apellidos', 'Cedula', 'Celular WhatsApp', 'Tiene WhatsApp', 'Correo', 'Ciudad Residencia', 'Barrio Residencia',
      'Nombre Taller', 'Ciudad Taller', 'Barrio Taller', 'Direccion Taller', 'Relacion Taller', 'Antiguedad Taller', 'Personas Taller',
      'Experiencia Mecanico', 'Especialidades', 'Tipos Motos', 'Marcas Motos', 'Motos Por Semana',
      'Quien Decide Repuesto', 'Frecuencia Recomendacion', 'Donde Compra', 'Marcas Repuestos Usadas', 'Factores Eleccion',
      'Conoce Nitrox', 'Como Conocio', 'Ha Usado Nitrox', 'Categorias Usadas', 'Calificacion Experiencia', 'Recomendaria Nitrox',
      'Actividades Interes', 'Temas Capacitacion', 'Autorizacion Datos', 'Autorizacion Comercial'
    ];

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const s = Array.isArray(str) ? str.join('; ') : String(str);
      return `"${s.replace(/"/g, '""')}"`;
    };

    let csvContent = '\uFEFF'; // UTF-8 BOM for Excel
    csvContent += headers.join(',') + '\r\n';

    list.forEach(m => {
      const row = [
        m.id_unico, m.fecha_registro, m.origen_registro, m.nivel_relacion_numero, m.nivel_relacion_nombre, m.score_potencial,
        m.nombres_apellidos, m.cedula, m.celular_whatsapp, m.tiene_whatsapp ? 'SI' : 'NO', m.correo, m.ciudad_residencia, m.barrio_residencia,
        m.nombre_taller, m.ciudad_taller, m.barrio_taller, m.direccion_taller, m.relacion_taller, m.antiguedad_taller, m.personas_taller,
        m.experiencia_mecanico, m.especialidad, m.tipo_motos, m.marcas_motos, m.motos_por_semana,
        m.quien_decide_repuesto, m.frecuencia_recomendacion, m.donde_compra_repuestos, m.marcas_repuestos_usadas, m.factores_eleccion_repuesto,
        m.conoce_nitrox, m.como_conocio_nitrox, m.ha_usado_nitrox, m.categorias_nitrox_usadas, m.calificacion_experiencia_nitrox, m.recomendaria_nitrox,
        m.actividades_interes, m.temas_capacitacion, m.autorizacion_tratamiento_datos ? 'SI' : 'NO', m.autorizacion_comunicaciones_comerciales ? 'SI' : 'NO'
      ];
      csvContent += row.map(escapeCsv).join(',') + '\r\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="RED_NITROX_Mecanicos_Medellin.csv"');
    return res.send(csvContent);
  } catch (err) {
    console.error('Error exportando CSV:', err);
    return res.status(500).send('Error exportando archivo CSV');
  }
});

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
  return res.redirect('/crm');
});

// 2. Incoming Messages Webhook (POST)
async function handleIncomingMessage(req, res) {
  const body = req.body;
  if (!body.entry || !body.entry[0].changes) {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const change = body.entry[0].changes[0].value;

  // Handle message status updates (sent, delivered, read, failed)
  if (change.statuses && change.statuses.length > 0) {
    for (const st of change.statuses) {
      console.log(`📊 [META STATUS]: +${st.recipient_id} -> ${st.status} (id: ${st.id})${st.errors ? ' ❌ ERROR: ' + JSON.stringify(st.errors) : ''}`);
    }
    return res.status(200).send('EVENT_RECEIVED');
  }

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
    console.log(`📩 [MENSAJE NO TEXTO (${message.type}) de +${from}]`);
    await sendWhatsAppMessage(from, 'hola! por ahora solo puedo leer mensajes de texto. cuentame que estas buscando en la plataforma hoy');
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