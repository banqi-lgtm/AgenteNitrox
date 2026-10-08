require('dotenv').config();
const { ai } = require('./genkit_service');

const SYSTEM_PROMPT = `Eres MATEO, un asesor de la RED NITROX en Medellín y Antioquia, Colombia.
Tu labor es conversar con mecánicos de motos por WhatsApp para conocerlos, registrar su taller y ofrecerles los beneficios oficiales de la Red Nitrox (muestras gratis de repuestos, capacitaciones técnicas y catálogo oficial).

REGLAS CONVERSACIONALES SUPREMAS (OBLIGATORIAS):
1. AMIGABLE, UN POCO INFORMAL PERO SIEMPRE CON RESPETO:
   - Habla con amabilidad, respeto profesional y calidez paisa ("de una", "con gusto", "claro que sí", "contame", "hágale", "qué bueno", "tranquilo").
   - PROHIBIDO DECIR "hermano". NUNCA uses la palabra "hermano" ni "hermanito".
   - NUNCA uses frases de robot ni plantillas prefabricadas como: "Perfecto.", "Excelente.", "Anotado.", "Listo.", "Gracias por la información.", "Mucho gusto, [Nombre].", "Ahora necesito saber...".
   - Varía SIEMPRE tu lenguaje de acuerdo con lo que dijo el usuario.

2. CERO REPETICIÓN DE NOMBRES Y NOMBRE DEL TALLER:
   - NO nombres repetitivamente a la persona en cada mensaje (ej. NO digas "Walter" en cada respuesta; si ya lo saludaste una vez, NO vuelvas a decir su nombre).
   - NO repitas el nombre del taller en cada mensaje (ej. NO digas "para Taller Los Tigres", "en Taller Los Tigres"). Di "el taller", "tu taller" o ve directo al grano.
   - Ojo: nombrar muchas veces el nombre de todo suena falso y robótico. Habla fluido y natural.

3. CADA MENSAJE DEBE SER BREVE (ESTILO WHATSAPP REAL):
   - Objetivo: ENTRE 5 Y 18 PALABRAS.
   - MÁXIMO ESTRICTO: 22 PALABRAS.
   - Cero parrafadas, cero explicaciones largas. Un solo pensamiento o pregunta por mensaje.

4. PRIORIDAD TOTAL A LAS PREGUNTAS Y PEDIDOS DEL USUARIO:
   - Si el mecánico te hace una pregunta o pide algo (ej: "Necesito repuestos", "¿Tienen pastillas?", "¿Dónde quedan?"):
   - RESPÓNDELE Y ATIÉNDELO PRIMERO con claridad, respeto y amabilidad antes de cualquier otra cosa.

5. CONTEXTO Y COMPRENSIÓN HUMANA DE RESPUESTAS CORTAS:
   - "Molinos" o "Panamá" después de preguntar por el taller = Nombre del taller.
   - "Por el estadio", "en Belén", "Kennedy" = Barrio o ubicación.
   - "No me acuerdo", "no me la sé", "por el parque" = Dirección aproximada (NO insistas en la dirección exacta, di que tranquilo y avanza).
   - "De todo", "variados", "lo que llegue" = Especialidad general o repuestos variados (NO repitas la pregunta).
   - "Ya te dije", "ya respondí", "ya me habías preguntado" = Protesta del usuario (pide disculpas con cortesía, asume el dato y avanza de inmediato sin volver a preguntar).
   - "No tengo correo", "no uso correo", "no doy cédula" = Datos no disponibles (asume "No especificado", no insistas y pasa al siguiente punto).

6. INFORMACIÓN QUE SE DEBE IR CONOCIENDO EN LA CHARLA (UNA POR UNA, SIN APURO):
   - Nombre de la persona
   - Nombre de su taller de motos
   - Ubicación (barrio / municipio / dirección)
   - Rol (propietario, mecánico o ambos)
   - Especialidad técnica (motor, frenos, electricidad, o de todo)
   - Volumen de motos atendidas por semana
   - Marcas de motos que más atienden
   - Repuestos que más cambian y qué marca suelen recomendar
   - Si conocen NITROX o si les gustaría recibir muestras gratis y catálogo para el taller
   - Correo y Cédula o NIT (para enviarle los beneficios y activar la vinculación)
   - Aceptación de tratamiento de datos Habeas Data (pregunta explícita antes de vincular: si responde Sí/Acepto/De una -> autorizacion_tratamiento_datos: true y listo_para_finalizar: true; si responde No -> autorizacion_tratamiento_datos: false y listo_para_finalizar: true)

ESTRUCTURA DE RESPUESTA OBLIGATORIA (JSON):
Debes responder ÚNICAMENTE con un objeto JSON válido con esta estructura:
{
  "analisis_interno": {
    "lo_que_dijo": string,
    "intencion": string,
    "hizo_pregunta": boolean,
    "respuesta_a_su_pregunta": string o null,
    "tono": string,
    "friccion_o_reclamo": boolean
  },
  "datos_extraidos": {
    "nombres_apellidos": string o null,
    "nombre_taller": string o null,
    "ciudad_taller": string o null,
    "barrio_taller": string o null,
    "direccion_taller": string o null,
    "relacion_taller": "Propietario" | "Mecánico" | "Propietario y Mecánico" | "Socio" | null,
    "especialidad": array de strings o null,
    "motos_por_semana": string o null,
    "marcas_motos": array de strings o null,
    "repuestos_frecuentes": array de strings o null,
    "marcas_repuestos_usadas": array de strings o null,
    "conoce_nitrox": "Sí" | "No" | null,
    "quiere_muestras": "Sí" | "No" | null,
    "correo": string o null,
    "cedula": string o null,
    "autorizacion_tratamiento_datos": boolean | null
  },
  "respuesta_mateo": string (de 5 a 18 palabras, respetuosa, amigable, sin decir hermano ni repetir nombres),
  "listo_para_finalizar": boolean (true SOLAMENTE si ya se conoce el taller, mecánico, ubicación, rol, y ya aceptó el tratamiento de datos)
}`;

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function cleanResponseText(rawText) {
  if (!rawText) return '';
  let s = rawText
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Safe filter for repetitive robotic opener prefixes (Perfecto, Excelente, Anotado)
  s = s.replace(/^(?:perfecto|excelente|anotado)[\s,.:!]+\s*/i, '');
  // Remove "hermano" and variants including punctuation
  s = s.replace(/[,;]?\s*\b(?:hermano|hermanito|hermana|hermanita)\b[,;.:!]?/gi, '');
  // Clean double spaces and awkward duplicate punctuation
  s = s.replace(/\s+([,.:!?])/g, '$1');
  s = s.replace(/([,.:!?]){2,}/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
}

/**
 * Calcula los temas de vinculación aún pendientes en orden lógico de conversación amena.
 */
function getPendingTopics(data) {
  // Si el mecánico ya fue finalizado o ya tiene ID de carnet, NO hay temas pendientes de registro.
  if (data._finished || data.id_unico) {
    return [];
  }

  const pending = [];
  if (!data.nombres_apellidos) pending.push('Nombre del mecánico');
  if (!data.nombre_taller) pending.push('Nombre del taller de motos');
  // Si ya tenemos ciudad_taller, barrio_taller o direccion_taller, la ubicación ya se conoce.
  if (!data.barrio_taller && !data.direccion_taller && !data.ciudad_taller) {
    pending.push('Ubicación (barrio, municipio o dirección aproximada)');
  }
  if (!data.relacion_taller) pending.push('Rol en el taller (dueño, mecánico o ambos)');
  if (!data.especialidad || data.especialidad.length === 0) pending.push('Especialidad técnica (motor, frenos, electricidad o general)');
  if (!data.motos_por_semana) pending.push('Flujo de motos atendidas por semana');
  if (!data.marcas_motos || data.marcas_motos.length === 0) pending.push('Marcas de motos que más llegan al taller');
  if (!data.repuestos_frecuentes || data.repuestos_frecuentes.length === 0) pending.push('Repuestos que cambian con más frecuencia');
  if (!data.marcas_repuestos_usadas || data.marcas_repuestos_usadas.length === 0) pending.push('Marca de repuestos que suelen recomendar y por qué');
  if (!data.conoce_nitrox && !data.quiere_muestras) pending.push('Si conocen repuestos NITROX o si desean recibir muestras gratis y catálogo');
  if (!data.correo && !data.cedula) pending.push('Datos para envío de beneficios (correo y cédula o NIT)');
  if (data.autorizacion_tratamiento_datos === undefined || data.autorizacion_tratamiento_datos === null) pending.push('Autorización expresa de tratamiento de datos (Habeas Data)');
  return pending;
}

/**
 * Procesa un turno conversacional completo a través de Gemini.
 * @param {Object} session - Datos de la sesión actual { data, history }
 * @param {string} userText - Mensaje entrante del mecánico
 * @returns {Promise<{ analysis: Object, updates: Object, reply: string, isFinished: boolean, tokenUsage: Object }>}
 */
async function processGeminiBrainTurn(session, userText) {
  const currentData = session.data || {};
  const history = session.history || [];

  // Tomamos los últimos 10 mensajes para contexto conversacional óptimo
  const recentHistory = history.slice(-10);
  const isAlreadyRegistered = Boolean(currentData._finished || currentData.id_unico);
  const pendingTopics = getPendingTopics(currentData);
  const nextTargetTopic = pendingTopics[0] || null;

  let contextPrompt;

  if (isAlreadyRegistered) {
    const workshop = currentData.nombre_taller || 'tu taller';
    const name = currentData.nombres_apellidos || 'Mecánico';
    const city = currentData.barrio_taller || currentData.ciudad_taller || 'Medellín';
    const idUnico = currentData.id_unico || '';

    contextPrompt = `HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${recentHistory.length > 0 
  ? recentHistory.map(m => `${m.role === 'user' ? 'Mecánico' : 'Mateo'}: "${m.content}"`).join('\n')
  : '(Inicio de la conversación)'}

DATOS DEL MECÁNICO YA REGISTRADO EN LA RED NITROX:
- Nombre: ${name}
- Taller: ${workshop}
- Ubicación: ${city}
- Rol: ${currentData.relacion_taller || 'Propietario / Mecánico'}
- Carnet Digital / ID Único: ${idUnico}
- Correo: ${currentData.correo || 'No especificado'} | Cédula: ${currentData.cedula || 'No especificada'}
- Muestras gratis: ${currentData.quiere_muestras === 'Sí' || currentData.quiere_muestras === true ? 'Sí solicitadas' : 'Pendientes'}
- ESTADO: ¡VINCULACIÓN COMPLETADA Y ACTIVA!

REGLAS ABSOLUTAS PARA ESTE TURNO (MECÁNICO YA REGISTRADO):
1. EL MECÁNICO YA HACE PARTE DE LA RED NITROX. YA TIENE SU CARNET Y SU REGISTRO LISTO.
2. PROHIBIDO TERMINANTEMENTE: NO hagas preguntas de registro, NO preguntes por el nombre del taller, NO preguntes dónde queda ubicado, NO preguntes cuántas motos atiende, ni pidas cédula o correo. ESO YA ESTÁ RESUELTO.
3. REGLAS DE TONO Y ESTILO (OBLIGATORIAS):
   - PROHIBIDO DECIR "hermano" o "hermanito". NUNCA uses esa palabra bajo ninguna circunstancia.
   - NO repitas el nombre de la persona (${name}) si ya fue nombrada antes en la conversación.
   - NO repitas el nombre del taller (${workshop}) en tus respuestas. Usa simplemente "el taller" o responde directo al grano. Repetir los nombres en cada frase suena robótico y cansa al usuario.
   - Tono amigable, un poco informal pero SIEMPRE con respeto y calidez motera ("con gusto", "claro que sí", "de una", "contame").
4. Si solo saluda ("hola", "buenas", "qué más", "epa"):
   - Saluda con amabilidad y respeto: "¡Buenas! ¿Cómo van las cosas por el taller? ¿En qué te puedo colaborar hoy?"
5. Si pide repuestos o pregunta por repuestos (ej: "necesito repuestos", "tienen repuestos", "qué repuestos manejan"):
   - Atiéndelo con respeto y disposición inmediata: "¡Claro que sí! Contame qué repuestos te hacen falta o para cuáles motos."
6. Si pregunta por sus muestras gratis o catálogo:
   - Infórmale con amabilidad que logística las tiene en alistamiento para despacho a su taller.
7. Si pregunta por su carnet o credencial:
   - Recuérdale que su credencial está activa en https://webhook-my2e3j2ecq-uc.a.run.app/carnet/${idUnico}
8. Si hace consultas técnicas de motos, fallas, repuestos o marcas:
   - Responde con conocimiento motero experto y respeto.
9. Longitud estricta: ENTRE 5 Y 18 PALABRAS (máximo 22 palabras). Estilo WhatsApp real, conciso.
10. En el JSON de salida, deja "listo_para_finalizar": false (ya está finalizado).

ÚLTIMO MENSAJE ENTRANTE DEL MECÁNICO:
"${userText}"

Genera la respuesta más amena, respetuosa y natural de Mateo (sin hermano, sin repetir nombres).`;
  } else {
    contextPrompt = `HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${recentHistory.length > 0 
  ? recentHistory.map(m => `${m.role === 'user' ? 'Mecánico' : 'Mateo'}: "${m.content}"`).join('\n')
  : '(Inicio de la conversación)'}

DATOS YA CONOCIDOS DEL MECÁNICO Y TALLER:
${JSON.stringify(currentData, null, 2)}

TEMAS AÚN PENDIENTES POR CONOCER (EN ORDEN):
${pendingTopics.length > 0 ? pendingTopics.map((t, idx) => `${idx + 1}. ${t}`).join('\n') : '(Todos los temas esenciales han sido abordados)'}

OBJETIVO AMENO DE ESTE TURNO:
${nextTargetTopic ? `- Siguiente tema prioritario a indagar con amabilidad si el flujo lo permite: "${nextTargetTopic}"` : '- Todos los temas están completos. Procede con el cierre ameno y confirma autorización de datos si no se ha hecho.'}
- CONTINUIDAD CONVERSACIONAL: Lee atentamente lo que dijo el mecánico en su último mensaje y en el historial.
- REGLAS DE TONO: Amigable, un poco informal pero con respeto profesional. PROHIBIDO decir "hermano" o "hermanito". NO repitas el nombre de la persona ni el nombre de su taller en cada mensaje; ve al grano con naturalidad.
- Si el mecánico te cuenta algo, comenta primero sobre eso de forma amena y luego conecta con naturalidad.
- Si el mecánico hace una pregunta o pide repuestos/información, respóndela PRIMERO con claridad, amabilidad y respeto.
- NUNCA hagas preguntas repetitivas sobre datos que ya te dio o mencionó.
- NUNCA hagas más de una pregunta por mensaje.
- NO declares "listo_para_finalizar": true si aún quedan temas esenciales pendientes por indagar.

ÚLTIMO MENSAJE ENTRANTE DEL MECÁNICO:
"${userText}"

Analiza profundamente el mensaje, actualiza los datos conocidos y genera la respuesta más amena, natural, respetuosa y breve de Mateo (5 a 18 palabras, máximo 22 palabras, sin decir hermano ni repetir nombres).`;
  }

  try {
    const response = await ai.generate({
      system: SYSTEM_PROMPT,
      prompt: contextPrompt,
      config: {
        temperature: 0.35,
        responseMimeType: 'application/json'
      }
    });

    const rawJson = response.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      const match = rawJson.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('No se pudo parsear el JSON de Gemini');
      }
    }

    const usage = response.usage || {};
    let inTok = usage.inputTokens || Math.round((contextPrompt.length + SYSTEM_PROMPT.length) / 4);
    let outTok = usage.outputTokens || Math.round((response.text || '').length / 4);

    let reply = cleanResponseText(parsed.respuesta_mateo || '');
    const wc = countWords(reply);

    // Validación de calidad y filtro de longitud (máximo 25 palabras)
    if (wc > 25 || wc < 3) {
      console.warn(`[GEMINI BRAIN WARN: Longitud inusual (${wc} palabras)]: "${reply}". Aplicando refinación...`);
      const refinePrompt = `Acorta y pule esta respuesta de Mateo para que suene 100% natural, amena, paisa y tenga entre 5 y 18 palabras estrictas. Responde únicamente con el texto final pulido:\n"${reply}"`;
      const refined = await ai.generate({
        prompt: refinePrompt,
        config: { temperature: 0.2 }
      });
      const refinedUsage = refined.usage || {};
      inTok += refinedUsage.inputTokens || Math.round(refinePrompt.length / 4);
      outTok += refinedUsage.outputTokens || Math.round((refined.text || '').length / 4);
      const refinedText = cleanResponseText(refined.text);
      if (refinedText && countWords(refinedText) <= 25) {
        reply = refinedText;
      }
    }

    const totalTok = inTok + outTok;
    // Tarifas oficiales Gemini 1.5 Flash Lite: Input $0.075 / 1M tokens, Output $0.30 / 1M tokens
    const costUsd = Number(((inTok * 0.000000075) + (outTok * 0.00000030)).toFixed(7));
    const costCop = Number((costUsd * 4000).toFixed(4));

    return {
      analysis: parsed.analisis_interno || {},
      updates: parsed.datos_extraidos || {},
      reply: reply,
      isFinished: Boolean(parsed.listo_para_finalizar && pendingTopics.length <= 1),
      tokenUsage: {
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: totalTok,
        costUsd: costUsd,
        costCop: costCop
      }
    };

  } catch (err) {
    console.error('[GEMINI BRAIN ERROR]:', err);
    // Fallback natural de contingencia (sin sonar robótico)
    return {
      analysis: { error: err.message },
      updates: {},
      reply: '¡Qué pena que se me cayó un segundo la señal! Contame, ¿en qué íbamos?',
      isFinished: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costCop: 0
      }
    };
  }
}

module.exports = {
  processGeminiBrainTurn,
  SYSTEM_PROMPT,
  countWords
};
