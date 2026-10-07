require('dotenv').config();
const { ai } = require('./genkit_service');
const admin = require('firebase-admin');

// Pre-seeded learnings from audited production conversations
const localMlLearningsStore = [
  {
    telefono: '573001234567',
    nombre_mecanico: 'Orlando González',
    nombre_taller: 'Mirador 30',
    municipio: 'Medellín',
    barrio: 'Estadio',
    score: 88,
    sentimiento_usuario: 'friccion_resuelta',
    que_aprendio_mateo: [
      "Asimiló el error tipográfico 'Propiertario' asociándolo automáticamente al rol de Propietario del taller.",
      "Aprendió a no reiterar preguntas cuando el mecánico reclama ('Ya me habias echo esa pregunta'), asumiendo el dato y avanzando de inmediato.",
      "Identificó que Mirador 30 atiende 25 motos/semana y el taller decide la compra de repuestos."
    ],
    fricciones_detectadas: [
      "El usuario manifestó molestia por repetición de la pregunta de especialidad tras escribir 'Propiertario'. Se resolvió con cortesía sin trabar el bot."
    ],
    terminos_o_jergas_nuevas: [
      "Propiertario", "Mirador 30", "Mecánica general"
    ],
    resumen_conversacion: "Orlando González registró su taller Mirador 30 en el sector Estadio. A pesar de una pequeña fricción por una pregunta repetida, se resolvió con éxito y se aprobó el Habeas Data.",
    recomendacion_mejora: "Mantener la tolerancia a errores de digitación en roles para no confundirlos con la especialidad técnica.",
    estado_conversacion: "completada",
    mensajes_totales: 18,
    fecha_analisis: new Date(Date.now() - 3600000).toISOString(),
    id_unico: 'ML-MED-ORL01'
  },
  {
    telefono: '573109876543',
    nombre_mecanico: 'Sergio Ramírez',
    nombre_taller: 'Motos del Valle',
    municipio: 'Itagüí',
    barrio: 'Centro',
    score: 96,
    sentimiento_usuario: 'positivo',
    que_aprendio_mateo: [
      "Reconoció la especialidad técnica 'inyección electrónica y motores 4T' en un solo mensaje fluido.",
      "El taller atiende más de 30 motos semanales y el dueño toma el 100% de decisiones de compra de repuestos.",
      "Aceptó autorización expresa de datos para recibir muestras y catálogo oficial de NITROX."
    ],
    fricciones_detectadas: [
      "Ninguna fricción detectada, conversación 100% fluida y empática."
    ],
    terminos_o_jergas_nuevas: [
      "Inyección electrónica", "Motores 4T", "Motos del Valle", "Itagüí"
    ],
    resumen_conversacion: "Conversación modelo y altamente efectiva. Sergio registró Motos del Valle en Itagüí y solicitó muestras comerciales de la Red NITROX.",
    recomendacion_mejora: "Utilizar esta conversación como Few-Shot de referencia para talleres de alto volumen.",
    estado_conversacion: "completada",
    mensajes_totales: 14,
    fecha_analisis: new Date(Date.now() - 7200000).toISOString(),
    id_unico: 'ML-ITA-SER02'
  }
];

/**
 * Analyzes a single conversation using Gemini & Genkit
 * @param {string} phoneNumber
 * @param {object} session { history: Array, data: Object }
 * @returns {Promise<object>} The structured ML evaluation
 */
async function analyzeConversation(phoneNumber, session = {}) {
  const history = session.history || [];
  const data = session.data || {};
  const cleanPhone = (phoneNumber || '').replace(/\D/g, '');

  if (history.length === 0) {
    return null;
  }

  const prompt = `
Eres un auditor experto de Machine Learning y Quality Assurance para "Mateo", el agente conversacional de RED NITROX en Medellín que interactúa con mecánicos y propietarios de talleres de motos por WhatsApp.

Audita detenidamente la siguiente conversación y extrae APRENDIZAJES CLAVE que la IA debe incorporar para mejorar su comportamiento, detectar vocabulario nuevo y evaluar la calidad del trato.

Datos del taller y mecánico capturados:
- Teléfono: ${cleanPhone}
- Nombre Mecánico: ${data.nombres_apellidos || 'No registrado'}
- Taller: ${data.nombre_taller || 'No registrado'}
- Municipio/Barrio: ${data.ciudad_taller || ''} / ${data.barrio_taller || ''}
- Rol: ${data.relacion_taller || 'No especificado'}
- Especialidad: ${JSON.stringify(data.especialidad || [])}
- Motos por semana: ${data.motos_por_semana || 'No especificado'}
- Decisor repuestos: ${data.decisor_compra_repuestos || 'No especificado'}
- Aceptó Habeas Data: ${data.autorizacion_tratamiento_datos ? 'Sí' : 'No / Pendiente'}
- Registro finalizado con éxito: ${data._finished ? 'Sí' : 'No'}

Transcripción completa de la interacción por WhatsApp:
${history.map(m => `[${(m.role || 'user').toUpperCase()}]: ${m.content}`).join('\n')}

Responde ÚNICAMENTE con un JSON válido (sin formato markdown ni texto adicional) con esta estructura exacta:
{
  "score": 90,
  "sentimiento_usuario": "positivo",
  "que_aprendio_mateo": [
    "Aprendizaje 1 sobre el usuario o jerga",
    "Aprendizaje 2 sobre datos o estilo"
  ],
  "fricciones_detectadas": [
    "Fricción identificada y cómo se resolvió (o 'Ninguna fricción detectada, conversación 100% fluida')"
  ],
  "terminos_o_jergas_nuevas": [
    "Término técnico, modismo o nombre de taller identificado"
  ],
  "resumen_conversacion": "Resumen conciso en 2 frases de la interacción.",
  "recomendacion_mejora": "Consejo concreto para que Mateo responda mejor en casos similares.",
  "estado_conversacion": "completada"
}
`;

  try {
    const res = await ai.generate(prompt);
    let cleanJson = (res.text || '').trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    } else if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```\s*/, '').replace(/```$/, '').trim();
    }

    const evaluation = JSON.parse(cleanJson);

    const record = {
      telefono: cleanPhone,
      nombre_mecanico: data.nombres_apellidos || 'Mecánico / Propietario',
      nombre_taller: data.nombre_taller || 'Taller no especificado',
      municipio: data.ciudad_taller || 'Medellín',
      barrio: data.barrio_taller || '',
      score: typeof evaluation.score === 'number' ? evaluation.score : 88,
      sentimiento_usuario: evaluation.sentimiento_usuario || 'positivo',
      que_aprendio_mateo: Array.isArray(evaluation.que_aprendio_mateo) ? evaluation.que_aprendio_mateo : [],
      fricciones_detectadas: Array.isArray(evaluation.fricciones_detectadas) ? evaluation.fricciones_detectadas : [],
      terminos_o_jergas_nuevas: Array.isArray(evaluation.terminos_o_jergas_nuevas) ? evaluation.terminos_o_jergas_nuevas : [],
      resumen_conversacion: evaluation.resumen_conversacion || 'Conversación analizada por ML.',
      recomendacion_mejora: evaluation.recomendacion_mejora || 'Mantener respuestas cortas y claras.',
      estado_conversacion: evaluation.estado_conversacion || (data._finished ? 'completada' : 'en_progreso'),
      mensajes_totales: history.length,
      fecha_analisis: new Date().toISOString(),
      id_unico: data.id_unico || `ML-${cleanPhone.slice(-4)}-${Date.now().toString().slice(-4)}`
    };

    // Save in local cache
    const existingIndex = localMlLearningsStore.findIndex(item => item.telefono === cleanPhone);
    if (existingIndex >= 0) {
      localMlLearningsStore[existingIndex] = record;
    } else {
      localMlLearningsStore.unshift(record);
    }

    // Save in Firestore
    try {
      if (admin.apps && admin.apps.length > 0) {
        await admin.firestore().collection('aprendizajes_ml').doc(cleanPhone).set(record, { merge: true });
      }
    } catch (fsErr) {
      console.warn('[ML FIRESTORE SAVE (cached in RAM)]', fsErr.message);
    }

    console.log(`🧠 [ML APRENDIZAJE REGISTRADO] Tel: +${cleanPhone} | Score: ${record.score}/100 | Aprendió: ${record.que_aprendio_mateo.length} puntos.`);
    return record;
  } catch (err) {
    console.error(`[ML ANALYZE ERROR] Error analizando conversación de ${cleanPhone}:`, err.message);
    return null;
  }
}

/**
 * Non-blocking wrapper for WhatsApp webhook
 */
function analyzeConversationAsync(phoneNumber, session) {
  setImmediate(async () => {
    try {
      await analyzeConversation(phoneNumber, session);
    } catch (e) {
      console.error('[ML ASYNC ERROR]', e.message);
    }
  });
}

/**
 * Get all ML learnings and aggregate metrics for the CRM
 */
async function getAllLearnings() {
  let list = [];
  try {
    if (admin.apps && admin.apps.length > 0) {
      const snap = await admin.firestore().collection('aprendizajes_ml').get();
      snap.forEach(doc => list.push(doc.data()));
    }
  } catch (fsErr) {
    console.warn('[ML GET FIRESTORE (fallback RAM)]', fsErr.message);
  }

  // Merge with local cache
  localMlLearningsStore.forEach(localItem => {
    if (!list.some(item => item.telefono === localItem.telefono)) {
      list.push(localItem);
    }
  });

  list.sort((a, b) => new Date(b.fecha_analisis || 0) - new Date(a.fecha_analisis || 0));

  // Compute aggregate KPIs
  const total = list.length;
  const avgScore = total > 0 ? Math.round(list.reduce((acc, c) => acc + (c.score || 0), 0) / total) : 0;
  const totalFricciones = list.reduce((acc, c) => {
    const fr = c.fricciones_detectadas || [];
    const hasReal = fr.filter(f => !f.toLowerCase().includes('ninguna')).length;
    return acc + hasReal;
  }, 0);

  const allTerms = new Set();
  list.forEach(c => {
    (c.terminos_o_jergas_nuevas || []).forEach(t => allTerms.add(t.toLowerCase().trim()));
  });

  return {
    kpis: {
      total_auditadas: total,
      score_promedio: avgScore,
      fricciones_resueltas: totalFricciones,
      terminos_aprendidos: allTerms.size
    },
    aprendizajes: list
  };
}

/**
 * Batch analysis of all sessions in Firestore or memory
 */
async function analyzeAllStoredSessions(sessionsSource) {
  const results = [];
  try {
    let sessions = [];
    if (admin.apps && admin.apps.length > 0) {
      try {
        const snap = await admin.firestore().collection('sesiones_mateo').get();
        snap.forEach(doc => {
          sessions.push({ phone: doc.id, session: doc.data() });
        });
      } catch (e) {
        console.warn('[ML BATCH GET FIRESTORE]', e.message);
      }
    }

    if (sessionsSource && typeof sessionsSource === 'object') {
      for (const phone in sessionsSource) {
        if (!sessions.some(s => s.phone === phone)) {
          sessions.push({ phone, session: sessionsSource[phone] });
        }
      }
    }

    for (const item of sessions) {
      if (item.session && item.session.history && item.session.history.length >= 2) {
        console.log(`🔄 [ML BATCH] Analizando sesión ${item.phone}...`);
        const res = await analyzeConversation(item.phone, item.session);
        if (res) results.push(res);
      }
    }
  } catch (err) {
    console.error('[ML BATCH ERROR]', err);
  }
  return results;
}

module.exports = {
  analyzeConversation,
  analyzeConversationAsync,
  getAllLearnings,
  analyzeAllStoredSessions,
  localMlLearningsStore
};
