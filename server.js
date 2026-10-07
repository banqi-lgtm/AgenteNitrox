require('dotenv').config();
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const path = require('path');
const { generateMateoResponse, admin, localMecanicosStore, resetMemoryCache } = require('./agent');
const { normalizeMechanicData } = require('./scoring');
const QRCode = require('qrcode');
const { generateCardImage } = require('./card_generator');

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

// Credencial Digital y Ficha Maestra con QR único
app.get(['/carnet', '/carnet/:id', '/ficha/:id', '/taller/:id'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'carnet.html'));
});

// Endpoint generador de imagen PNG para Código QR oficial
app.get('/api/qr/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'webhook-my2e3j2ecq-uc.a.run.app';
    const targetUrl = `${protocol}://${host}/carnet/${encodeURIComponent(id)}`;

    const qrBuffer = await QRCode.toBuffer(targetUrl, {
      type: 'png',
      width: 480,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(qrBuffer);
  } catch (err) {
    console.error('Error generando QR PNG:', err);
    return res.status(500).send('Error generando QR');
  }
});

// Endpoint generador de la Credencial Completa Oficial con QR en formato imagen PNG
app.get('/api/card-image/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    let mechanic = (localMecanicosCache || []).find(m => m.id_unico === id);

    if (!mechanic) {
      try {
        const doc = await admin.firestore().collection('mecanicos_red_nitrox').doc(id).get();
        if (doc.exists) {
          mechanic = doc.data();
        } else {
          const snap = await admin.firestore().collection('mecanicos_red_nitrox').where('id_unico', '==', id).get();
          if (!snap.empty) mechanic = snap.docs[0].data();
        }
      } catch (e) {
        console.warn('[CARD IMAGE LOOKUP ERROR]:', e.message);
      }
    }

    const mechanicData = mechanic || {
      id_unico: id,
      nombre_taller: 'Taller Aliado',
      nombres_apellidos: 'Mecánico Vinculado',
      ciudad_taller: 'Medellín',
      relacion_taller: 'Mecánico',
      motos_por_semana: 'Alto Flujo'
    };

    const imageBuffer = await generateCardImage(mechanicData);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', imageBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(imageBuffer);
  } catch (err) {
    console.error('Error generando imagen de credencial:', err);
    return res.status(500).send('Error generando imagen');
  }
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

async function sendWhatsAppImage(to, imageUrl, caption) {
  try {
    const cleanTo = String(to || '').replace(/\D/g, '');
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption || ''
        }
      })
    });
    const data = await res.json();
    console.log(`[META ENVIO IMAGEN A +${cleanTo}]:`, JSON.stringify(data));
    if (data.error) {
      console.warn(`[META IMAGE WARN]:`, data.error.message);
    }
    return data;
  } catch (error) {
    console.warn('Error enviando imagen a', to, error.message);
  }
}

// ==========================================
// MACHINE LEARNING DASHBOARD & AUDIT APIS
// ==========================================

// Get all ML learnings and aggregated metrics
app.get('/api/ml/aprendizajes', requireAuth, async (req, res) => {
  try {
    const { getAllLearnings } = require('./ml_service');
    const data = await getAllLearnings();
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('Error obteniendo aprendizajes de ML:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Trigger ML analysis on a specific conversation
app.post('/api/ml/analizar/:phone', requireAuth, async (req, res) => {
  try {
    const phone = (req.params.phone || '').replace(/\D/g, '');
    let session = null;
    try {
      const doc = await admin.firestore().collection('sesiones_mateo').doc(phone).get();
      if (doc.exists) session = doc.data();
    } catch (e) {
      console.warn('[ML GET SESSION FIRESTORE]', e.message);
    }

    if (!session) {
      return res.status(404).json({ success: false, message: `No se encontró sesión para el teléfono +${phone}` });
    }

    const { analyzeConversation } = require('./ml_service');
    const result = await analyzeConversation(phone, session);
    return res.json({ success: true, aprendizaje: result });
  } catch (err) {
    console.error('Error analizando conversación ML:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Trigger batch ML analysis on all stored conversations
app.post('/api/ml/analizar-todas', requireAuth, async (req, res) => {
  try {
    const { analyzeAllStoredSessions } = require('./ml_service');
    const resultados = await analyzeAllStoredSessions();
    return res.json({ success: true, count: resultados.length, resultados });
  } catch (err) {
    console.error('Error en análisis batch de ML:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Reset Endpoint: Deletes all conversation sessions and marks Mateo at zero
app.post('/api/admin/reset-conversations', requireAuth, async (req, res) => {
  try {
    let deletedSessions = 0;
    let deletedProcessed = 0;

    // 1. Delete all docs in sesiones_mateo
    try {
      const snapSessions = await admin.firestore().collection('sesiones_mateo').get();
      const batch1 = admin.firestore().batch();
      snapSessions.forEach(doc => {
        batch1.delete(doc.ref);
        deletedSessions++;
      });
      if (deletedSessions > 0) await batch1.commit();
    } catch (e) {
      console.warn('[RESET SESSIONS]', e.message);
    }

    // 2. Delete all docs in mensajes_procesados
    try {
      const snapMsg = await admin.firestore().collection('mensajes_procesados').get();
      const batch2 = admin.firestore().batch();
      snapMsg.forEach(doc => {
        batch2.delete(doc.ref);
        deletedProcessed++;
      });
      if (deletedProcessed > 0) await batch2.commit();
    } catch (e) {
      console.warn('[RESET PROCESSED]', e.message);
    }

    // 3. Clear memory caches
    resetMemoryCache();
    processedMessageIds.clear();

    console.log(`🧹 [RESET CONVERSACIONES] ${deletedSessions} sesiones y ${deletedProcessed} mensajes borrados. Mateo está en cero.`);

    return res.json({
      success: true,
      message: 'Todas las conversaciones de Mateo han sido borradas. Mateo está en cero como si no reconociera a nadie.',
      deletedSessions,
      deletedProcessed
    });
  } catch (err) {
    console.error('Error al resetear conversaciones:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Mark message as read
async function markMessageAsRead(messageId) {
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
        message_id: messageId
      })
    });
    const d = await res.json();
    if (d.error) console.warn('[META READ STATUS]:', d.error.message);
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
    // 1. Mark message as read
    await markMessageAsRead(messageId);

    // 2. Natural human pause: 800ms - 1200ms
    const initialDelay = Math.floor(Math.random() * 400) + 800;
    console.log(`⏳ [ESCRIBIENDO...] Pausa de ${(initialDelay / 1000).toFixed(1)}s...`);
    await sleep(initialDelay);

    // 3. Generate response bubbles
    const bubbles = await generateMateoResponse(from, incomingText);

    // 4. Send bubbles with smooth natural interval (350ms)
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      if (bubble && typeof bubble === 'object' && bubble.type === 'image') {
        console.log(`📤 [MATEO ENVIA IMAGEN QR a +${from}]: "${bubble.url}"`);
        await sendWhatsAppImage(from, bubble.url, bubble.caption);
      } else if (typeof bubble === 'string' && bubble.trim()) {
        console.log(`📤 [MATEO RESPONDE (${i + 1}/${bubbles.length}) a +${from}]: "${bubble}"`);
        await sendWhatsAppMessage(from, bubble);
      }

      if (i < bubbles.length - 1) {
        await sleep(400);
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

app.get('/api/genkit/run', async (req, res) => {
  try {
    const { helloFlow } = require('./genkit_service');
    const text = await helloFlow(req.query.name || 'Firebase-Monitoring');
    await new Promise(r => setTimeout(r, 6000));
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

exports.webhook = onRequest({ cors: true, invoker: 'public' }, app);

exports.helloFlow = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  try {
    const { helloFlow } = require('./genkit_service');
    const text = await helloFlow(req.query.name || 'Firebase-Monitoring');
    await new Promise(r => setTimeout(r, 6000));
    res.json({ success: true, text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module && !process.env.FUNCTION_TARGET && !process.env.K_SERVICE) {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor Mateo NITROX activo en el puerto ${PORT}`);
  });
}