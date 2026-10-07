require('dotenv').config();
const { ai } = require('./genkit_service');

const SYSTEM_PROMPT = `Eres MATEO, un asesor humano, empático y parcero de la RED NITROX en Medellín y Antioquia, Colombia.
Tu labor es conversar con mecánicos de motos por WhatsApp para conocerlos, registrar su taller y ofrecerles los beneficios oficiales de la Red Nitrox (muestras gratis de repuestos, capacitaciones técnicas y catálogo oficial).

REGLAS CONVERSACIONALES SUPREMAS:
1. ERES UNA PERSONA REAL, NO UN BOT:
   - Habla con naturalidad, calidez e informalidad respetuosa, típica de un paisa conocedor del gremio de motos ("qué más", "de una", "bacano", "hermano", "parcero", "tranquilo", "upa qué bien").
   - NUNCA uses frases de robot ni plantillas prefabricadas como: "Perfecto.", "Excelente.", "Anotado.", "Listo.", "Gracias por la información.", "Mucho gusto, [Nombre].", "Ahora necesito saber...".
   - Varía SIEMPRE tu lenguaje de acuerdo con lo que dijo el usuario.

2. CADA MENSAJE DEBE SER BREVE (ESTILO WHATSAPP REAL):
   - Objetivo: ENTRE 5 Y 20 PALABRAS.
   - MÁXIMO ESTRICTO: 25 PALABRAS.
   - Cero parrafadas, cero explicaciones largas. Un solo pensamiento o pregunta por mensaje.

3. PRIORIDAD TOTAL A LAS PREGUNTAS DEL USUARIO:
   - Si el mecánico te hace una pregunta (ej: "¿Ustedes venden repuestos?", "¿Dónde quedan?", "¿Qué es la Red Nitrox?", "¿Quién eres?", "¿Tienen pastillas?"):
   - RESPÓNDELE PRIMERO con claridad y amabilidad en ese mismo mensaje, y luego continúa de forma fluida.

4. NUNCA REPETIR EL NOMBRE DEL MECÁNICO EN CADA MENSAJE:
   - Si ya lo saludaste con su nombre ("Mucho gusto Walter"), NO vuelvas a decir su nombre en los siguientes mensajes. Solo menciónalo cuando sea 100% natural después de varios turnos.

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
  "respuesta_mateo": string (de 5 a 20 palabras, paisa, humana, conversacional),
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
  return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
}

/**
 * Procesa un turno conversacional completo a través de Gemini.
 * @param {Object} session - Datos de la sesión actual { data, history }
 * @param {string} userText - Mensaje entrante del mecánico
 * @returns {Promise<{ analysis: Object, updates: Object, reply: string, isFinished: boolean }>}
 */
async function processGeminiBrainTurn(session, userText) {
  const currentData = session.data || {};
  const history = session.history || [];

  // Tomamos los últimos 8 mensajes para contexto conversacional óptimo
  const recentHistory = history.slice(-8);

  const contextPrompt = `HISTORIAL RECIENTE DE LA CONVERSACIÓN:
${recentHistory.length > 0 
  ? recentHistory.map(m => `${m.role === 'user' ? 'Mecánico' : 'Mateo'}: "${m.content}"`).join('\n')
  : '(Inicio de la conversación)'}

DATOS YA CONOCIDOS DEL MECÁNICO Y TALLER:
${JSON.stringify(currentData, null, 2)}

ÚLTIMO MENSAJE ENTRANTE DEL MECÁNICO:
"${userText}"

Analiza profundamente el mensaje, actualiza los datos conocidos y genera la respuesta más natural, empática y breve de Mateo (5 a 20 palabras, máximo 25 palabras).`;

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

    let reply = cleanResponseText(parsed.respuesta_mateo || '');
    const wc = countWords(reply);

    // Validación de calidad y filtro de longitud (máximo 25 palabras)
    if (wc > 25 || wc < 3) {
      console.warn(`[GEMINI BRAIN WARN: Longitud inusual (${wc} palabras)]: "${reply}". Aplicando refinación...`);
      const refinePrompt = `Acorta y pule esta respuesta de Mateo para que suene 100% natural, paisa y tenga entre 5 y 18 palabras estrictas. Responde únicamente con el texto final pulido:\n"${reply}"`;
      const refined = await ai.generate({
        prompt: refinePrompt,
        config: { temperature: 0.2 }
      });
      const refinedText = cleanResponseText(refined.text);
      if (refinedText && countWords(refinedText) <= 25) {
        reply = refinedText;
      }
    }

    return {
      analysis: parsed.analisis_interno || {},
      updates: parsed.datos_extraidos || {},
      reply: reply,
      isFinished: Boolean(parsed.listo_para_finalizar)
    };

  } catch (err) {
    console.error('[GEMINI BRAIN ERROR]:', err);
    // Fallback natural de contingencia (sin sonar robótico)
    return {
      analysis: { error: err.message },
      updates: {},
      reply: '¡Qué más hermano! Qué pena que se me cayó un segundo la señal. ¿Me decías?',
      isFinished: false
    };
  }
}

module.exports = {
  processGeminiBrainTurn,
  SYSTEM_PROMPT,
  countWords
};
