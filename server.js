require('dotenv').config();
const express = require('express');
const { onRequest } = require('firebase-functions/v2/https');
const path = require('path');
const { generateMateoResponse, admin, localMecanicosStore, getAllSessions, saveSession, memoryCache, resetMemoryCache } = require('./agent');
const { normalizeMechanicData } = require('./scoring');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isRunningInCloud = Boolean(
  process.env.K_SERVICE || 
  process.env.FUNCTION_TARGET || 
  process.env.GOOGLE_CLOUD_PROJECT || 
  process.env.GCP_PROJECT ||
  process.env.K_REVISION ||
  process.env.CLOUD_RUN_JOB
);
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

// Caché en memoria para entrega ultrarrápida (<5ms) de la imagen de credencial y QR a WhatsApp
const cardImageCache = new Map();
global.cardImageCache = cardImageCache;

// Endpoint generador de la Credencial Completa Oficial con QR en formato imagen PNG
app.get('/api/card-image/:id.png', async (req, res) => {
  try {
    const id = req.params.id;
    if (cardImageCache.has(id)) {
      const cached = cardImageCache.get(id);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', cached.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

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

    const { generateCardImage } = require('./card_generator');
    const imageBuffer = await generateCardImage(mechanicData);
    cardImageCache.set(id, imageBuffer);

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

// ===== Formulario corto con link único por mecánico (/completar/:token) + Perfil (/perfil/:token) =====
const REG_ENGINE = require('./registration_engine');
const PUBLIC_BASE_URL = 'https://webhook-my2e3j2ecq-uc.a.run.app';
// Campos de la ficha maestra que se pueden completar en el formulario (en orden de prioridad).
// Solo se muestran los que NO quedaron respondidos en la conversación con Mateo.
const COMPLETAR_FIELDS = [
  'correo', 'cedula', 'barrio_taller', 'direccion_taller', 'experiencia_mecanico',
  'antiguedad_taller', 'personas_taller', 'quien_decide_repuesto', 'donde_compra_repuestos', 'marcas_repuestos_usadas'
];
const COMPLETAR_ARRAY_FIELDS = ['donde_compra_repuestos', 'marcas_repuestos_usadas'];
const COMPLETAR_MAX = 5;

function getFormPendingFields(m) {
  return COMPLETAR_FIELDS.filter(k => {
    const def = REG_ENGINE.MASTER_FIELDS[k];
    if (!def) return false;
    try { return !def.isValid(m[k]); } catch (_) { return true; }
  }).slice(0, COMPLETAR_MAX);
}

async function findMechanicByToken(token) {
  if (!token || token.length < 8) return null;
  const local = (localMecanicosCache || []).find(m => m.form_token === token);
  if (local) return local;
  try {
    const snap = await admin.firestore().collection('mecanicos_red_nitrox').where('form_token', '==', token).limit(1).get();
    if (!snap.empty) return snap.docs[0].data();
  } catch (e) {
    console.warn('[COMPLETAR LOOKUP]', e.message);
  }
  return null;
}

// Registra en el historial de la conversación (CRM) un mensaje enviado fuera del flujo del webhook
async function appendAssistantMessageToSession(phone, content) {
  const entry = { role: 'assistant', content, timestamp: Date.now() };
  try {
    if (memoryCache[phone]) {
      memoryCache[phone].history = memoryCache[phone].history || [];
      memoryCache[phone].history.push(entry);
    }
    await admin.firestore().collection('sesiones_mateo').doc(phone)
      .set({ history: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
  } catch (e) {
    console.warn('[SESSION APPEND]', e.message);
  }
}

app.get('/completar/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'completar.html'));
});

app.get('/perfil/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'perfil.html'));
});

app.get('/api/completar/:token', async (req, res) => {
  const m = await findMechanicByToken(req.params.token);
  if (!m) return res.status(404).json({ success: false, message: 'Link no válido' });
  return res.json({
    success: true,
    nombre: m.nombres_apellidos || '',
    taller: m.nombre_taller || '',
    ubicacion: [m.barrio_taller, m.ciudad_taller].filter(Boolean).join(', '),
    id_unico: m.id_unico,
    pending: getFormPendingFields(m),
    intereses: m.actividades_interes || [],
    completado: Boolean(m.formulario_completado_en)
  });
});

app.post('/api/completar/:token', async (req, res) => {
  const m = await findMechanicByToken(req.params.token);
  if (!m) return res.status(404).json({ success: false, message: 'Link no válido' });
  const body = req.body || {};
  const clean = (v, max = 120) => String(v || '').trim().slice(0, max);
  const pending = getFormPendingFields(m);
  const updates = {};
  for (const k of pending) {
    const v = clean(body[k]);
    if (!v) continue;
    updates[k] = COMPLETAR_ARRAY_FIELDS.includes(k)
      ? v.split(/[,;\/]| y /i).map(s => s.trim()).filter(Boolean).slice(0, 8)
      : v;
  }
  if (updates.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.correo)) {
    return res.status(400).json({ success: false, message: 'El correo no parece válido' });
  }
  if (updates.cedula) {
    updates.cedula = updates.cedula.replace(/\D/g, '').slice(0, 12);
    if (updates.cedula.length < 6) return res.status(400).json({ success: false, message: 'La cédula no parece válida' });
  }
  const allowedInterests = ['Capacitaciones técnicas', 'Premios y concursos', 'Ruta NITROX (visitas)'];
  if (Array.isArray(body.intereses)) {
    const ints = body.intereses.filter(i => allowedInterests.includes(i));
    updates.actividades_interes = Array.from(new Set([...(m.actividades_interes || []), ...ints]));
    if (ints.includes('Capacitaciones técnicas')) {
      updates.temas_capacitacion = Array.from(new Set([...(m.temas_capacitacion || []), 'Capacitaciones técnicas']));
    }
  }
  if (body.acepta_comunicaciones === true) updates.autorizacion_comunicaciones_comerciales = true;
  const firstTime = !m.formulario_completado_en;
  updates.formulario_completado_en = new Date().toISOString();

  Object.assign(m, updates);
  try {
    await admin.firestore().collection('mecanicos_red_nitrox').doc(m.id_unico).set(updates, { merge: true });
  } catch (e) {
    console.warn('[COMPLETAR SAVE]', e.message);
  }

  // Confirmación por WhatsApp con el link único al perfil
  const profileUrl = `${PUBLIC_BASE_URL}/perfil/${encodeURIComponent(req.params.token)}`;
  const phone = String(m.wa_user_id || '').trim() || String(m.celular_whatsapp || '').replace(/\D/g, '');
  if (phone && firstTime) {
    const msg = `✅ *Recibimos tu información.* ¡Gracias!\n\nAquí puedes ver tu perfil RED NITROX cuando quieras:\n👉 ${profileUrl}`;
    try {
      await sendWhatsAppMessage(phone, msg);
      await appendAssistantMessageToSession(phone, msg);
    } catch (e) {
      console.warn('[COMPLETAR WHATSAPP]', e.message);
    }
  }
  return res.json({ success: true, profileUrl });
});

// Perfil público del mecánico (solo con su token privado)
app.get('/api/perfil/:token', async (req, res) => {
  const m = await findMechanicByToken(req.params.token);
  if (!m) return res.status(404).json({ success: false, message: 'Perfil no encontrado' });
  const arr = v => (Array.isArray(v) ? v : (v ? [v] : [])).filter(x => x && !/^no especificad|^no aplica/i.test(String(x)));
  const val = v => (v && !/^no especificad|^no aplica/i.test(String(v)) ? v : '');
  return res.json({
    success: true,
    id_unico: m.id_unico,
    nombre: m.nombres_apellidos || '',
    taller: m.nombre_taller || '',
    rol: val(m.relacion_taller),
    ciudad: m.ciudad_taller || '',
    barrio: m.barrio_taller || '',
    direccion: m.direccion_taller || '',
    experiencia: val(m.experiencia_mecanico),
    antiguedad: val(m.antiguedad_taller),
    personas: val(m.personas_taller),
    motos_semana: val(m.motos_por_semana),
    especialidad: arr(m.especialidad),
    marcas_motos: arr(m.marcas_motos),
    repuestos: arr(m.repuestos_frecuentes),
    marcas_repuestos: arr(m.marcas_repuestos_usadas),
    intereses: arr(m.actividades_interes),
    nivel: m.nivel_relacion_numero || 1,
    nivel_nombre: m.nivel_relacion_nombre || 'Registrado',
    fecha_registro: m.fecha_registro || '',
    card_image: `/api/card-image/${encodeURIComponent(m.id_unico)}.png`,
    form_url: `/completar/${encodeURIComponent(req.params.token)}`,
    pendientes: getFormPendingFields(m).length
  });
});

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

// CRM Mecánicos List API (incluye vinculados oficiales + prospectos con datos en conversación activa)
app.get('/api/crm/mecanicos', requireAuth, async (req, res) => {
  try {
    // Si corre en localhost, consultar en vivo a producción para evitar timeouts locales
    if (!isRunningInCloud) {
      try {
        const prodRes = await fetch('https://webhook-my2e3j2ecq-uc.a.run.app/api/crm/mecanicos', {
          headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
        });
        if (prodRes.ok) {
          const prodData = await prodRes.json();
          if (prodData.success && Array.isArray(prodData.mecanicos)) {
            localMecanicosStore.length = 0;
            prodData.mecanicos.forEach(m => localMecanicosStore.push(m));
            return res.json(prodData);
          }
        }
      } catch (e) {
        console.warn('[CRM MECANICOS PROD PROXY FALLBACK]', e.message);
      }
    }

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

    // Incluir sesiones activas para que aparezcan en tiempo real en la base de mecánicos y fichas
    try {
      const allSessions = await getAllSessions();
      const { normalizeMechanicData } = require('./scoring');
      for (const sess of allSessions) {
        const phone = sess.phone || (sess.data && sess.data.celular_whatsapp) || '';
        const d = sess.data || {};
        const hasData = Boolean(d.nombres_apellidos || d.nombre_taller || (sess.history && sess.history.length >= 2));
        if (!hasData) continue;

        const isAlreadyInList = list.some(item => {
          if (d.id_unico && item.id_unico === d.id_unico) return true;
          if (phone && (item.celular_whatsapp === phone || item.wa_user_id === phone)) return true;
          if (d.celular_whatsapp && item.celular_whatsapp === d.celular_whatsapp) return true;
          return false;
        });

        if (!isAlreadyInList) {
          const isBsuid = /[A-Za-z]/.test(phone);
          const cleanPhone = isBsuid ? (d.celular_whatsapp || '') : phone.replace(/\D/g, '');
          const tempId = d.id_unico || `PROSP-${(cleanPhone.slice(-4) || phone.slice(-4) || 'WA')}-${(d.nombre_taller || d.nombres_apellidos || 'PROSPECTO').slice(0, 4).toUpperCase().replace(/\W/g, '')}`;
          const normalized = normalizeMechanicData({
            ...d,
            id_unico: tempId,
            celular_whatsapp: cleanPhone,
            wa_user_id: isBsuid ? phone : (d.wa_user_id || ''),
            estado_mecanico: d._finished ? 'Activo' : 'En proceso de registro',
            origen_registro: d._finished ? 'WhatsApp' : 'WhatsApp (En conversación)',
            fecha_registro: d.fecha_registro || (sess.history && sess.history[0]?.timestamp ? new Date(sess.history[0].timestamp).toISOString() : new Date().toISOString())
          }, 'WhatsApp');
          list.push(normalized);
        }
      }
    } catch (sessErr) {
      console.warn('[CRM MECANICOS SESSIONS MERGE]', sessErr.message);
    }

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

// CRM Mecánicos Corrección / Actualización Completa (Admin)
app.post('/api/crm/corregir-mecanico/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body || {};

    try {
      const docRef = admin.firestore().collection('mecanicos_red_nitrox').doc(id);
      await docRef.set(updates, { merge: true });

      const phone = updates.wa_user_id || updates.celular_whatsapp;
      if (phone) {
        const sessRef = admin.firestore().collection('sesiones_mateo').doc(phone);
        const snap = await sessRef.get();
        if (snap.exists) {
          const s = snap.data() || {};
          s.data = Object.assign(s.data || {}, updates);
          await sessRef.set(s, { merge: true });
        }
      }
    } catch (fsErr) {
      console.warn('[CORREGIR FIRESTORE ERROR]', fsErr.message);
    }

    const item = localMecanicosStore.find(m => m.id_unico === id || (updates.wa_user_id && m.wa_user_id === updates.wa_user_id));
    if (item) Object.assign(item, updates);

    return res.json({ success: true, updated: updates });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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

// Meta: usuarios con "nombre de usuario" de WhatsApp pueden ocultar su número.
// En ese caso llega un BSUID (ej. "CO.1234567890") y se debe enviar con `recipient` en lugar de `to`.
function isBsuid(id) {
  return /[A-Za-z]/.test(String(id || ''));
}
function buildRecipient(id) {
  const raw = String(id || '').trim();
  if (isBsuid(raw)) return { recipient: raw };
  return { to: raw.replace(/\D/g, '') };
}

async function sendWhatsAppMessage(to, text) {
  try {
    if (!to) {
      console.error('❌ [ENVIO CANCELADO] destinatario vacío');
      return null;
    }
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...buildRecipient(to),
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
    const cleanTo = String(to || '');
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...buildRecipient(to),
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

// Get full session conversation history for a specific phone
app.get('/api/crm/conversacion/:phone', requireAuth, async (req, res) => {
  try {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    const doc = await admin.firestore().collection('sesiones_mateo').doc(cleanPhone).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: `No se encontró sesión para +${cleanPhone}` });
    }
    const session = doc.data();
    return res.json({ success: true, phone: cleanPhone, session });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Helper to compute token stats for any session (ensuring historical sessions also display realistic token economics)
function computeSessionTokenStats(session) {
  if (session.tokenStats && session.tokenStats.totalTokens > 0) {
    return session.tokenStats;
  }

  let inTok = 0;
  let outTok = 0;
  let turns = 0;

  const history = session.history || [];
  history.forEach(msg => {
    if (msg.role === 'assistant') {
      turns++;
      if (msg.tokens && msg.tokens.totalTokens) {
        inTok += (msg.tokens.inputTokens || 0);
        outTok += (msg.tokens.outputTokens || 0);
      } else {
        const ansTok = Math.max(10, Math.round((msg.content || '').length / 4));
        const promptTok = 350 + (turns * 40);
        inTok += promptTok;
        outTok += ansTok;
      }
    }
  });

  const total = inTok + outTok;
  const costUsd = Number(((inTok * 0.000000075) + (outTok * 0.00000030)).toFixed(7));
  const costCop = Number((costUsd * 4000).toFixed(4));

  return {
    totalInputTokens: inTok,
    totalOutputTokens: outTok,
    totalTokens: total,
    totalCostUsd: costUsd,
    totalCostCop: costCop,
    turnsCount: turns
  };
}

// 1. Resumen global de tokens y costos económicos
app.get('/api/crm/tokens-resumen', requireAuth, async (req, res) => {
  try {
    // Si corre en localhost, consultar en vivo a producción para paridad total e inmediata con WhatsApp
    if (!isRunningInCloud) {
      try {
        const prodRes = await fetch('https://webhook-my2e3j2ecq-uc.a.run.app/api/crm/tokens-resumen', {
          headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
        });
        if (prodRes.ok) return res.json(await prodRes.json());
      } catch (e) {
        // Fallback a cálculo local si no hay internet
      }
    }

    const allSessions = await getAllSessions();
    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalCostCop = 0;
    let totalTurns = 0;

    allSessions.forEach(sess => {
      const stats = computeSessionTokenStats(sess);
      totalInput += stats.totalInputTokens;
      totalOutput += stats.totalOutputTokens;
      totalTokens += stats.totalTokens;
      totalCostUsd += stats.totalCostUsd;
      totalCostCop += stats.totalCostCop;
      totalTurns += stats.turnsCount;
    });

    const activeCount = allSessions.filter(s => !(s.data && s.data._finished)).length;
    const finishedCount = allSessions.filter(s => s.data && s.data._finished).length;

    const avgTokens = allSessions.length ? Math.round(totalTokens / allSessions.length) : 0;
    const avgCostUsd = allSessions.length ? (totalCostUsd / allSessions.length) : 0;
    const avgCostCop = allSessions.length ? (totalCostCop / allSessions.length) : 0;

    return res.json({
      success: true,
      pricing: {
        model: 'gemini-1.5-flash-lite',
        inputPricePerMillion: 0.075,
        outputPricePerMillion: 0.30,
        copExchangeRate: 4000
      },
      metricas: {
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalTokens: totalTokens,
        totalCostUsd: Number(totalCostUsd.toFixed(5)),
        totalCostCop: Number(totalCostCop.toFixed(2)),
        totalConversaciones: allSessions.length,
        conversacionesActivas: activeCount,
        conversacionesFinalizadas: finishedCount,
        totalTurnosInteractivos: totalTurns,
        promedioTokensPorConversacion: avgTokens,
        promedioCostoUsdPorConversacion: Number(avgCostUsd.toFixed(6)),
        promedioCostoCopPorConversacion: Number(avgCostCop.toFixed(2))
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Lista de conversaciones en vivo con métricas de tokens y costos
app.get('/api/crm/conversaciones-en-vivo', requireAuth, async (req, res) => {
  try {
    // Si corre en localhost, consultar en vivo a producción
    if (!isRunningInCloud) {
      try {
        const prodRes = await fetch('https://webhook-my2e3j2ecq-uc.a.run.app/api/crm/conversaciones-en-vivo', {
          headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
        });
        if (prodRes.ok) return res.json(await prodRes.json());
      } catch (e) {
        // Fallback
      }
    }

    const allSessions = await getAllSessions();

    const list = allSessions.map(sess => {
      const stats = computeSessionTokenStats(sess);
      const data = sess.data || {};
      const history = sess.history || [];
      const lastMsg = history[history.length - 1] || null;

      return {
        phone: sess.phone,
        nombres_apellidos: data.nombres_apellidos || 'Sin nombre',
        nombre_taller: data.nombre_taller || 'Sin taller registrado',
        barrio_taller: data.barrio_taller || data.ciudad_taller || 'Medellín',
        relacion_taller: data.relacion_taller || 'Mecánico',
        id_unico: data.id_unico || null,
        estado: data._finished ? 'finalizada' : (history.length > 0 ? 'en_curso' : 'iniciada'),
        mensajesTotales: history.length,
        ultimoMensaje: lastMsg ? {
          role: lastMsg.role,
          content: lastMsg.content,
          timestamp: lastMsg.timestamp || Date.now()
        } : null,
        tokens: stats,
        data: data
      };
    });

    list.sort((a, b) => {
      const timeA = a.ultimoMensaje ? (a.ultimoMensaje.timestamp || 0) : 0;
      const timeB = b.ultimoMensaje ? (b.ultimoMensaje.timestamp || 0) : 0;
      return timeB - timeA;
    });

    return res.json({ success: true, count: list.length, conversaciones: list });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Detalle completo de una conversación en vivo
app.get('/api/crm/conversacion-en-vivo/:phone', requireAuth, async (req, res) => {
  try {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');

    // Si corre en localhost, consultar en vivo a producción
    if (!isRunningInCloud) {
      try {
        const prodRes = await fetch(`https://webhook-my2e3j2ecq-uc.a.run.app/api/crm/conversacion-en-vivo/${cleanPhone}`, {
          headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
        });
        if (prodRes.ok) return res.json(await prodRes.json());
      } catch (e) {
        // Fallback
      }
    }

    const allSessions = await getAllSessions();
    const sess = allSessions.find(s => String(s.phone).replace(/\D/g, '') === cleanPhone);

    if (!sess) {
      return res.status(404).json({ success: false, message: `No se encontró conversación para +${cleanPhone}` });
    }

    const stats = computeSessionTokenStats(sess);
    const historyWithTokens = (sess.history || []).map(msg => {
      if (msg.role === 'assistant') {
        const t = msg.tokens || {};
        const inT = t.inputTokens || 350;
        const outT = t.outputTokens || Math.max(10, Math.round((msg.content || '').length / 4));
        const total = inT + outT;
        const costUsd = Number(((inT * 0.000000075) + (outT * 0.00000030)).toFixed(7));
        const costCop = Number((costUsd * 4000).toFixed(4));
        return {
          ...msg,
          tokens: {
            inputTokens: inT,
            outputTokens: outT,
            totalTokens: total,
            costUsd,
            costCop
          }
        };
      }
      return msg;
    });

    let progress = null;
    try {
      const { getRegistrationProgress, MASTER_FIELDS } = require('./registration_engine');
      const p = getRegistrationProgress(sess.data || {}, sess.memory || {});
      progress = {
        percentage: p.progressPercentage,
        canFinalize: p.canFinalize,
        fields: Object.entries(MASTER_FIELDS).map(([key, def]) => ({
          key,
          label: def.label,
          section: def.section,
          mandatory: def.mandatory,
          state: p.fieldStatus[key]?.state || 'PENDIENTE',
          value: p.fieldStatus[key]?.value ?? null
        }))
      };
    } catch (e) {
      progress = null;
    }

    return res.json({
      success: true,
      phone: cleanPhone,
      data: sess.data || {},
      tokenStats: stats,
      progress,
      history: historyWithTokens
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin manual message dispatch via WhatsApp Cloud API
app.post('/api/admin/send-whatsapp', requireAuth, async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ success: false, message: 'Falta to o text en el cuerpo de la solicitud' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const metaRes = await sendWhatsAppMessage(cleanTo, text);
    return res.json({ success: true, to: cleanTo, metaResponse: metaRes });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Update Session Endpoint
app.post('/api/admin/actualizar-sesion/:phone', requireAuth, async (req, res) => {
  try {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    const { dataUpdates, addHistoryMessage } = req.body;
    const docRef = admin.firestore().collection('sesiones_mateo').doc(cleanPhone);
    const doc = await docRef.get();
    let session = doc.exists ? doc.data() : { data: {}, history: [] };
    if (!session.data) session.data = {};
    if (!session.history) session.history = [];

    if (dataUpdates) {
      Object.assign(session.data, dataUpdates);
    }
    if (addHistoryMessage) {
      session.history.push({
        role: addHistoryMessage.role || 'assistant',
        content: addHistoryMessage.content,
        timestamp: addHistoryMessage.timestamp || Date.now()
      });
    }

    await docRef.set(session, { merge: true });
    return res.json({ success: true, phone: cleanPhone, session });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Reset Endpoint: Deletes all conversation sessions, token stats and ML learnings, marking Mateo at zero
app.post('/api/admin/reset-conversations', requireAuth, async (req, res) => {
  try {
    let deletedSessions = 0;
    let deletedProcessed = 0;
    let deletedMl = 0;

    // Si corre en localhost, propagar el reset a producción primero
    if (!isRunningInCloud) {
      try {
        await fetch('https://webhook-my2e3j2ecq-uc.a.run.app/api/admin/reset-conversations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });
      } catch (fwdErr) {
        console.warn('⚠️ [RESET FWD TO PROD WARNING]:', fwdErr.message);
      }
    }

    // 1. Delete all docs in sesiones_mateo (en la nube)
    if (isRunningInCloud) {
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

      // 3. Delete all docs in aprendizajes_ml
      try {
        const snapMl = await admin.firestore().collection('aprendizajes_ml').get();
        const batch3 = admin.firestore().batch();
        snapMl.forEach(doc => {
          batch3.delete(doc.ref);
          deletedMl++;
        });
        if (deletedMl > 0) await batch3.commit();
      } catch (e) {
        console.warn('[RESET ML]', e.message);
      }

      // 4. Clean accidental test mechanic record if created prematurely
      try {
        const snapTest = await admin.firestore().collection('mecanicos_red_nitrox').where('id_unico', '==', 'RN-MED-5796DKR9').get();
        snapTest.forEach(async doc => await doc.ref.delete());
        const snapTest2 = await admin.firestore().collection('mecanicos_red_nitrox').where('nombre_taller', '==', 'Taller Leones La 50').get();
        snapTest2.forEach(async doc => await doc.ref.delete());
      } catch (e) {
        console.warn('[RESET TEST MECHANIC]', e.message);
      }
    }

    // 5. Clear memory caches
    resetMemoryCache();
    processedMessageIds.clear();
    localMecanicosCache = localMecanicosCache.filter(m => m.id_unico !== 'RN-MED-5796DKR9' && m.nombre_taller !== 'Taller Leones La 50');
    try {
      const { resetMlLearnings } = require('./ml_service');
      if (resetMlLearnings) resetMlLearnings();
    } catch (e) {}

    console.log(`🧹 [RESET CONVERSACIONES] ${deletedSessions} sesiones, ${deletedProcessed} mensajes y ${deletedMl} auditorías ML borradas. Mateo y sus métricas están en cero.`);

    return res.json({
      success: true,
      message: 'Todas las conversaciones, estadísticas de tokens y aprendizajes de Mateo han sido reiniciados a cero.',
      deletedSessions,
      deletedProcessed,
      deletedMl
    });
  } catch (err) {
    console.error('Error al resetear conversaciones:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint Maestro: Limpia el CRM completo (Mecánicos, Sesiones, Mensajes Procesados, Auditorías ML y Caches)
app.post('/api/admin/wipe-crm', requireAuth, async (req, res) => {
  try {
    let deletedMecanicos = 0;
    let deletedSessions = 0;
    let deletedProcessed = 0;
    let deletedMl = 0;

    // Si corre en localhost, propagar a producción
    if (!isRunningInCloud) {
      try {
        await fetch('https://webhook-my2e3j2ecq-uc.a.run.app/api/admin/wipe-crm', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });
      } catch (fwdErr) {
        console.warn('⚠️ [WIPE FWD WARNING]:', fwdErr.message);
      }
    }

    if (isRunningInCloud) {
      // 1. Borrar todos los mecánicos en Firestore
      try {
        const snapMecs = await admin.firestore().collection('mecanicos_red_nitrox').get();
        const batch1 = admin.firestore().batch();
        snapMecs.forEach(doc => { batch1.delete(doc.ref); deletedMecanicos++; });
        if (deletedMecanicos > 0) await batch1.commit();
      } catch (e) { console.warn('[WIPE MECANICOS]', e.message); }

      // 2. Borrar todas las sesiones
      try {
        const snapSess = await admin.firestore().collection('sesiones_mateo').get();
        const batch2 = admin.firestore().batch();
        snapSess.forEach(doc => { batch2.delete(doc.ref); deletedSessions++; });
        if (deletedSessions > 0) await batch2.commit();
      } catch (e) { console.warn('[WIPE SESSIONS]', e.message); }

      // 3. Borrar mensajes procesados
      try {
        const snapMsg = await admin.firestore().collection('mensajes_procesados').get();
        const batch3 = admin.firestore().batch();
        snapMsg.forEach(doc => { batch3.delete(doc.ref); deletedProcessed++; });
        if (deletedProcessed > 0) await batch3.commit();
      } catch (e) { console.warn('[WIPE MSG]', e.message); }

      // 4. Borrar auditorías ML
      try {
        const snapMl = await admin.firestore().collection('aprendizajes_ml').get();
        const batch4 = admin.firestore().batch();
        snapMl.forEach(doc => { batch4.delete(doc.ref); deletedMl++; });
        if (deletedMl > 0) await batch4.commit();
      } catch (e) { console.warn('[WIPE ML]', e.message); }
    }

    // 5. Vaciar caches en memoria
    resetMemoryCache();
    processedMessageIds.clear();
    localMecanicosCache.length = 0;
    localMecanicosStore.length = 0;
    if (global.cardImageCache) global.cardImageCache.clear();
    try {
      const { resetMlLearnings } = require('./ml_service');
      if (resetMlLearnings) resetMlLearnings();
    } catch (e) {}

    console.log(`💥 [WIPE TOTAL CRM] ${deletedMecanicos} mecánicos, ${deletedSessions} sesiones, ${deletedProcessed} mensajes eliminados. CRM limpio a cero.`);

    return res.json({
      success: true,
      message: 'CRM, base de datos y memoria limpiados al 100%. Todo en cero para empezar de nuevo.',
      deletedMecanicos,
      deletedSessions,
      deletedProcessed,
      deletedMl
    });
  } catch (err) {
    console.error('Error al limpiar CRM:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Mark message as read and show 3 dots typing indicator ("escribiendo...") in WhatsApp
async function markMessageAsReadAndTyping(messageId) {
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
    if (d.error) {
      console.warn('[META TYPING NOTICE]:', d.error.message);
      // Fallback: send standard read status without typing_indicator if needed
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
    } else {
      console.log(`💬 [META TYPING ACTIVADO] 3 puntos "escribiendo..." en WhatsApp para mensaje ${messageId}`);
    }
  } catch (err) {
    console.warn('[META READ/TYPING CATCH]:', err.message);
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
  const contact = (change.contacts && change.contacts[0]) || {};
  // Número si Meta lo envía; si el usuario usa "nombre de usuario", Meta oculta el número y manda un BSUID
  const phoneCandidate = [message.from, contact.wa_id].find(v => v && /^\d{8,15}$/.test(String(v)));
  const from = phoneCandidate || message.from || message.from_user_id || contact.user_id || contact.wa_id;
  if (!from) {
    console.error('❌ [REMITENTE DESCONOCIDO] Payload sin from/from_user_id:', JSON.stringify(change).slice(0, 1500));
    return res.status(200).send('EVENT_RECEIVED');
  }
  if (!phoneCandidate) {
    console.log(`🪪 [USUARIO SIN NÚMERO VISIBLE] BSUID=${from} nombre=${contact.profile?.name || ''}`);
  }

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
    // 1. Mark message as read and show 3 dots typing indicator in WhatsApp
    await markMessageAsReadAndTyping(messageId);

    // 2. Pausa natural ágil de escritura en WhatsApp (200ms - 350ms)
    const initialDelay = Math.floor(Math.random() * 150) + 200;
    console.log(`⏳ [ESCRIBIENDO...] Mostrando indicador de escritura por ${(initialDelay / 1000).toFixed(2)}s...`);
    await sleep(initialDelay);

    // 3. Generate response bubbles
    const bubbles = await generateMateoResponse(from, incomingText);

    // 4. Send bubbles with snappy interval (150ms)
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
        await sleep(150);
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

// Local Development Sync: Automatically sync production data to RAM when running on localhost
async function syncFromProductionIfLocal() {
  if (isRunningInCloud) {
    return;
  }
  try {
    const prodBase = 'https://webhook-my2e3j2ecq-uc.a.run.app';
    const authHeaders = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

    console.log('🔄 [LOCALHOST SYNC] Sincronizando datos de talleres y tokens desde producción...');
    
    // 1. Sync mechanics
    const mecsRes = await fetch(`${prodBase}/api/crm/mecanicos`, { headers: authHeaders });
    if (mecsRes.ok) {
      const mecsData = await mecsRes.json();
      if (Array.isArray(mecsData.mecanicos) && mecsData.mecanicos.length > 0) {
        localMecanicosStore.length = 0;
        mecsData.mecanicos.forEach(m => localMecanicosStore.push(m));
        console.log(`✅ [LOCALHOST SYNC] ${localMecanicosStore.length} mecánicos sincronizados.`);
      }
    }

    // 2. Sync conversations & sessions
    const convsRes = await fetch(`${prodBase}/api/crm/conversaciones-en-vivo`, { headers: authHeaders });
    if (convsRes.ok) {
      const convsData = await convsRes.json();
      if (Array.isArray(convsData.conversaciones)) {
        for (const conv of convsData.conversaciones) {
          const detailRes = await fetch(`${prodBase}/api/crm/conversacion-en-vivo/${conv.phone}`, { headers: authHeaders });
          if (detailRes.ok) {
            const detail = await detailRes.json();
            if (detail.success) {
              const session = {
                data: detail.data || {},
                history: detail.history || [],
                tokenStats: detail.tokenStats || {}
              };
              await saveSession(conv.phone, session);
            }
          }
        }
        console.log(`✅ [LOCALHOST SYNC] Conversaciones y tokens sincronizados.`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [LOCALHOST SYNC WARNING]:', err.message);
  }
}

app.post('/api/crm/sync-production', requireAuth, async (req, res) => {
  try {
    await syncFromProductionIfLocal();
    return res.json({ success: true, count: localMecanicosStore.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Standalone server entrypoint (Google Cloud Run container or Localhost)
if (require.main === module && !process.env.FUNCTION_TARGET) {
  const HOST = '0.0.0.0';
  app.listen(PORT, HOST, async () => {
    console.log(`🚀 Servidor Mateo NITROX escuchando en http://${HOST}:${PORT} [Modo: ${isRunningInCloud ? 'Cloud Run (' + (process.env.K_SERVICE || 'agente-nitrox') + ')' : 'Localhost'}]`);
    if (!isRunningInCloud) {
      await syncFromProductionIfLocal();
    }
  });
}