// nlp_pipeline.js - Procesamiento de Lenguaje Natural en Español para MATEO (RED NITROX Colombia)
// Etapas:
// A. Normalización (expansión de modismos y abreviaciones WhatsApp sin alterar significado original)
// B. Tokenización (unidades léxicas y expresiones multipalabra)
// C. Lematización contextual (diferenciación sustantivo vs. verbo, mapeo a lemas estándar)
// D. Extracción Semántica (ciudades, marcas, repuestos, volumen, roles, consultas comerciales, negaciones)

/**
 * Normaliza el texto de WhatsApp tolerando informalidad y abreviaciones colombianas
 * Mantiene intacto el mensaje original para referencias posteriores.
 */
function normalizeText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { original: '', normalized: '' };
  }

  const original = rawText.trim();
  let text = original;

  // 1. Limpieza de caracteres de control y normalización de espacios
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  // 2. Diccionario de abreviaturas y modismos frecuentes en WhatsApp Colombia
  const abbreviations = [
    // Preposiciones y conjunciones (con límites Unicode para no afectar palabras con tildes)
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:q|ke)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'que' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:xq|pq|xk)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'por qué' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:d)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'de' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:tb|tbn|tmb)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'también' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:pa)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'para' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ala)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'a la' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:dnd|x dnd)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'dónde' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:porfa|xfa|xfav)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'por favor' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:uds|ustes)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'ustedes' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ps)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'pues' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:bn)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'bien' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:pto)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'punto' },
    // Términos mecánicos y repuestos abreviados
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:kt\s+d\s+arrastre|kit\s+d\s+arrastre|kit\s+arrastre)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'kit de arrastre' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:taller\s+d\s+motos)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'taller de motos' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:rep|repuests)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'repuestos' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:ptas|pastillitas)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'pastillas' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:inyecc)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'inyección' },
    { pattern: /(?<=^|[^\p{L}\p{N}])(?:electr)(?=[^\p{L}\p{N}]|$)/giu, replacement: 'electricidad' }
  ];

  for (const item of abbreviations) {
    text = text.replace(item.pattern, item.replacement);
  }

  // 3. Normalizar puntuación excesiva (ej. "???" -> "?", "!!!" -> "!")
  text = text.replace(/([?!.,;:]){2,}/g, '$1');
  text = text.replace(/\s+([,.:!?])/g, '$1');

  return {
    original: original,
    normalized: text
  };
}

/**
 * Tokeniza el texto reconociendo palabras individuales y frases compuestas de alto valor semántico.
 */
function tokenize(text) {
  if (!text) return [];

  // Expresiones multipalabra prioritarias del dominio motero / comercial
  const multiWordExpressions = [
    'kit de arrastre',
    'pastillas de freno',
    'inyección electrónica',
    'mecánica general',
    'alto cilindraje',
    'bajo cilindraje',
    'por semana',
    'al día',
    'a la semana',
    'al mes',
    'red nitrox',
    'muestras gratis',
    'tratamiento de datos',
    'propietario y mecánico',
    'dueño y mecánico'
  ];

  let workingText = text.toLowerCase();
  const detectedMultiWords = [];

  for (const mwe of multiWordExpressions) {
    if (workingText.includes(mwe)) {
      detectedMultiWords.push(mwe);
    }
  }

  // Separar tokens individuales
  const cleanForTokens = text.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'¡¿]/g, ' ');
  const rawTokens = cleanForTokens.split(/\s+/).filter(Boolean);

  return {
    rawTokens,
    multiWords: detectedMultiWords
  };
}

/**
 * Lematizador contextual en español.
 * Distingue explícitamente entre sustantivos y verbos según su contexto gramatical
 * (ej. "el trabajo" [sustantivo] vs. "trabajo con yamaha" [verbo]).
 */
function lemmatize(tokenInfo, fullText) {
  const { rawTokens } = tokenInfo;
  const lowerFull = (fullText || '').toLowerCase();

  // Diccionario morfológico de formas verbales
  const verbMap = {
    // trabajar
    'trabajo': 'trabajar',
    'trabajas': 'trabajar',
    'trabaja': 'trabajar',
    'trabajamos': 'trabajar',
    'trabajan': 'trabajar',
    'trabajando': 'trabajar',
    'trabajé': 'trabajar',
    // cambiar
    'cambio': 'cambiar',
    'cambias': 'cambiar',
    'cambia': 'cambiar',
    'cambiamos': 'cambiar',
    'cambian': 'cambiar',
    'cambiando': 'cambiar',
    'cambié': 'cambiar',
    // atender
    'atiendo': 'atender',
    'atiendes': 'atender',
    'atiende': 'atender',
    'atendemos': 'atender',
    'atienden': 'atender',
    'atendiendo': 'atender',
    'atendí': 'atender',
    // reparar / arreglar
    'reparo': 'reparar',
    'repara': 'reparar',
    'reparamos': 'reparar',
    'reparan': 'reparar',
    'reparando': 'reparar',
    'arreglo': 'arreglar',
    'arreglas': 'arreglar',
    'arregla': 'arreglar',
    'arreglamos': 'arreglar',
    'arreglan': 'arreglar',
    'arreglando': 'arreglar',
    // comprar
    'compro': 'comprar',
    'compras': 'comprar',
    'compra': 'comprar',
    'compramos': 'comprar',
    'compran': 'comprar',
    'comprando': 'comprar',
    // recomendar
    'recomiendo': 'recomendar',
    'recomiendas': 'recomendar',
    'recomienda': 'recomendar',
    'recomendamos': 'recomendar',
    'recomiendan': 'recomendar',
    'recomendando': 'recomendar',
    // llegar
    'llego': 'llegar',
    'llega': 'llegar',
    'llegan': 'llegar',
    'llegamos': 'llegar',
    'llegando': 'llegar'
  };

  // Diccionario de formas plurales a singulares
  const nounPluralMap = {
    'repuestos': 'repuesto',
    'motos': 'moto',
    'motocicletas': 'motocicleta',
    'talleres': 'taller',
    'pastillas': 'pastilla',
    'bandas': 'banda',
    'discos': 'disco',
    'cadenas': 'cadena',
    'motores': 'motor',
    'cilindros': 'cilindro',
    'pistones': 'pistón',
    'válvulas': 'válvula',
    'valvulas': 'válvula',
    'rodamientos': 'rodamiento',
    'balineras': 'balinera',
    'llantas': 'llanta',
    'mecánicos': 'mecánico',
    'mecanicos': 'mecánico',
    'marcas': 'marca',
    'clientes': 'cliente',
    'muestras': 'muestra'
  };

  const lemmatizedTokens = rawTokens.map((token, idx) => {
    const lower = token.toLowerCase();

    // 1. Desambiguación contextual de "trabajo": ¿Sustantivo o Verbo?
    if (lower === 'trabajo') {
      const prevWord = idx > 0 ? rawTokens[idx - 1].toLowerCase() : '';
      if (['el', 'mi', 'su', 'nuestro', 'mucho', 'bastante', 'buen', 'un', 'este'].includes(prevWord) ||
          lowerFull.includes('bastante trabajo') || lowerFull.includes('mucho trabajo')) {
        return { token, lemma: 'trabajo', pos: 'sustantivo' };
      }
      return { token, lemma: 'trabajar', pos: 'verbo' };
    }

    // 2. Desambiguación contextual de "cambio": ¿Sustantivo o Verbo?
    if (lower === 'cambio') {
      const prevWord = idx > 0 ? rawTokens[idx - 1].toLowerCase() : '';
      if (['el', 'un', 'este', 'primer', 'segundo'].includes(prevWord) || lowerFull.includes('cambio de aceite')) {
        return { token, lemma: 'cambio', pos: 'sustantivo' };
      }
      return { token, lemma: 'cambiar', pos: 'verbo' };
    }

    // 3. Verbos conocidos
    if (verbMap[lower]) {
      return { token, lemma: verbMap[lower], pos: 'verbo' };
    }

    // 4. Plurales de sustantivos
    if (nounPluralMap[lower]) {
      return { token, lemma: nounPluralMap[lower], pos: 'sustantivo' };
    }

    return { token, lemma: lower, pos: 'desconocido' };
  });

  return lemmatizedTokens;
}

/**
 * Extracción Semántica de Entidades y Hechos desde el mensaje.
 * Extrae simultáneamente múltiples hechos independientes en el mismo turno.
 */
function extractSemanticEntities(text, sessionContext = {}) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase().replace(/[.,!¡?¿]+/g, ' ');

  const extracted = {
    // Entidades clave
    ciudad_taller: null,
    barrio_taller: null,
    direccion_taller: null,
    nombres_apellidos: null,
    nombre_taller: null,
    relacion_taller: null,
    equipo_taller: null,
    especialidad: null,
    motos_por_semana: null,
    marcas_motos: null,
    repuestos_frecuentes: null,
    marcas_repuestos_usadas: null,
    criterio_compra: null,
    canal_compra: null,

    // Relación comercial e intereses
    frecuencia_recomendacion: null,
    quien_decide_repuesto: null,
    recomendaria_nitrox: null,
    conoce_nitrox: null,
    quiere_muestras: null,
    interes_comercial_detalles: null,

    // Datos de contacto y formalización
    celular_whatsapp: null,
    telefono_alterno: null,
    correo: null,
    cedula: null,

    // Señales conversacionales y de control
    es_pregunta_comercial: false,
    pregunta_comercial_tema: null,
    protesta_repeticion: false,
    rechazo_dato: {},
    situacion_salud_o_personal: false,
    rechazo_hostil: false,
    friccion_o_reclamo: false,
    autorizacion_habeas_data: null
  };

  // 1. PROTESTA POR REPETICIÓN (Regla: "Ya te dije", "Ya respondí", etc.)
  if (/(?:ya\s+(?:me\s+)?hab[ií]as|ya\s+te\s+(?:dije|respond[ií])|eso\s+ya|ya\s+lo\s+dije|ya\s+respond[ií]|pregunta\s+ya)/i.test(lower)) {
    extracted.protesta_repeticion = true;
  }

  // 2. RECHAZOS Y NEGATIVAS EXPLÍCITAS DE DATOS (Regla: "Prefiero no dar cédula", "no tengo correo")
  if (/no\s*(?:quiero|prefiero\s*no|doy|voy\s*a\s*dar)\s*(?:la\s*)?(?:c[eé]dula|cc|nit)/i.test(lower) ||
      /(?:prefiero\s*no\s*dar\s*la\s*c[eé]dula|sin\s*c[eé]dula)/i.test(lower)) {
    extracted.rechazo_dato.cedula = 'Rechazado expresamente por el usuario';
    extracted.cedula = 'No proporcionada (rechazada por el usuario)';
  }

  const isAskingEmail = sessionContext._lastQuestion === 'CORREO' || /correo/i.test(sessionContext.lastAssistantMessage || '');
  if (isAskingEmail && /^(?:no\s+tengo|no\s+uso|no\s+manejo|no\b)/i.test(lower)) {
    extracted.rechazo_dato.correo = 'No dispone o no usa correo';
    extracted.correo = 'No disponible / No usa';
  } else if (/(?:no\s*tengo\s*correo|no\s*uso\s*correo|no\s*manejo\s*correo|sin\s*correo)/i.test(lower)) {
    extracted.rechazo_dato.correo = 'No dispone o no usa correo';
    extracted.correo = 'No disponible / No usa';
  }

  // Detección de situaciones de salud, dolor o malestar físico personal
  if (/\b(?:duele\s+el\s+est[oó]mago|dolor\s+de\s+cabeza|enferm[oa]|dolor|hospital|m[eé]dico|maluca|maluco|me\s+siento\s+mal)\b/i.test(lower) || /:\(|😢|🤒/.test(raw)) {
    extracted.situacion_salud_o_personal = true;
  }

  // Detección de rechazo hostil o insultos en autorización / registro
  const isHostileHabeas = /\b(?:lo\s+autorizar[aá]\s+tu\s+madre|su\s+madre|tu\s+madre|no\s+autorizo\s+(?:un\s+carajo|nada|ni\s+mierda)|no\s+me\s+jod[a-z]*|v[aá]yase\s+a\s+la\s+mierda|coma\s+mierda)\b/i.test(lower) || /😡|🤬/.test(raw);
  if (isHostileHabeas) {
    extracted.autorizacion_tratamiento_datos = false;
    extracted.rechazo_dato.autorizacion_tratamiento_datos = 'Rechazo hostil';
    extracted.rechazo_hostil = true;
    extracted.friccion_o_reclamo = true;
  }

  // 3. CONSULTAS COMERCIALES DEL USUARIO (Regla: Responder primero a sus dudas antes de seguir con vinculación)
  // Ejemplos: "¿Ustedes quiénes son o qué hacen?", "¿Tienen pastillas para una NKD?", "¿Dónde quedan?"
  if (/\b(?:qui[eé]nes\s+son|qu[eé]\s+hacen|de\s+qu[eé]\s+es\s+nitrox|qu[eé]\s+es\s+red\s+nitrox)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'identidad_empresa';
  } else if (/\b(?:tienen|manejan|venden|hay|consiguen)\b.*?\b(?:pastillas?|frenos?|kit|arrastre|repuesto|bater[ií]a|llanta|cadena|aceite|cilindro)\b/i.test(lower) ||
             /\b(?:pastillas?|kit\s+de\s+arrastre|repuestos?)\b.*?\b(?:para|pa)\b.*?\b(?:nkd|boxer|pulsar|yamaha|akt|honda|nmax|fz|gixxer)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'consulta_repuesto_referencia';
  } else if (/\b(?:d[oó]nde\s+quedan|d[oó]nde\s+est[aá]n|ubicaci[oó]n\s+de\s+ustedes|tienen\s+sede)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'ubicacion_empresa';
  } else if (/\b(?:cu[aá]nto\s+cuesta|qu[eé]\s+precio|precios|cat[aá]logo)\b/i.test(lower)) {
    extracted.es_pregunta_comercial = true;
    extracted.pregunta_comercial_tema = 'precios_catalogo';
  }

  // 4. CIUDADES, MUNICIPIOS Y TALLERES COMPUESTOS ("Pj en Bogotá", "La 50 en Medellín", "Taller El Paisa en Cali")
  const municipalities = [
    { name: 'Bogotá', regex: /\b(?:bogot[aá]|dc|bogota\s*dc)\b/i },
    { name: 'Medellín', regex: /\b(?:medell[ií]n|medallo)\b/i },
    { name: 'Cali', regex: /\b(?:cali)\b/i },
    { name: 'Barranquilla', regex: /\b(?:barranquilla|quilla)\b/i },
    { name: 'Cartagena', regex: /\b(?:cartagena)\b/i },
    { name: 'Bucaramanga', regex: /\b(?:bucaramanga|bucara)\b/i },
    { name: 'Pereira', regex: /\b(?:pereira)\b/i },
    { name: 'Manizales', regex: /\b(?:manizales)\b/i },
    { name: 'Cúcuta', regex: /\b(?:c[uú]cuta)\b/i },
    { name: 'Ibagué', regex: /\b(?:ibagu[eé])\b/i },
    { name: 'Santa Marta', regex: /\b(?:santa\s+marta)\b/i },
    { name: 'Villavicencio', regex: /\b(?:villavicencio|villavo)\b/i },
    { name: 'Pasto', regex: /\b(?:pasto)\b/i },
    { name: 'Montería', regex: /\b(?:monter[ií]a)\b/i },
    { name: 'Valledupar', regex: /\b(?:valledupar)\b/i },
    { name: 'Armenia', regex: /\b(?:armenia)\b/i },
    { name: 'Popayán', regex: /\b(?:popay[aá]n)\b/i },
    { name: 'Neiva', regex: /\b(?:neiva)\b/i },
    { name: 'Sincelejo', regex: /\b(?:sincelejo)\b/i },
    { name: 'Tunja', regex: /\b(?:tunja)\b/i },
    { name: 'Riohacha', regex: /\b(?:riohacha)\b/i },
    { name: 'Florencia', regex: /\b(?:florencia)\b/i },
    { name: 'Yopal', regex: /\b(?:yopal)\b/i },
    { name: 'Quibdó', regex: /\b(?:quibd[oó])\b/i },
    { name: 'Soacha', regex: /\b(?:soacha)\b/i },
    { name: 'Bello', regex: /\b(?:bello)\b/i },
    { name: 'Itagüí', regex: /\b(?:itag[uü][ií]|itagui)\b/i },
    { name: 'Envigado', regex: /\b(?:envigado)\b/i },
    { name: 'Sabaneta', regex: /\b(?:sabaneta)\b/i },
    { name: 'La Estrella', regex: /\b(?:la\s+estrella|estrella)\b/i },
    { name: 'Caldas', regex: /\b(?:caldas)\b/i },
    { name: 'Copacabana', regex: /\b(?:copacabana)\b/i },
    { name: 'Girardota', regex: /\b(?:girardota)\b/i },
    { name: 'Barbosa', regex: /\b(?:barbosa)\b/i },
    { name: 'Rionegro', regex: /\b(?:rionegro)\b/i },
    { name: 'Palmira', regex: /\b(?:palmira)\b/i },
    { name: 'Dosquebradas', regex: /\b(?:dosquebradas)\b/i },
    { name: 'Floridablanca', regex: /\b(?:floridablanca)\b/i },
    { name: 'Girón', regex: /\b(?:gir[oó]n)\b/i },
    { name: 'Piedecuesta', regex: /\b(?:piedecuesta)\b/i },
    { name: 'Barrancabermeja', regex: /\b(?:barrancabermeja)\b/i },
    { name: 'Tuluá', regex: /\b(?:tulu[aá])\b/i },
    { name: 'Facatativá', regex: /\b(?:facatativ[aá]|faca)\b/i },
    { name: 'Fusagasugá', regex: /\b(?:fusagasug[aá]|fusa)\b/i },
    { name: 'Chía', regex: /\b(?:ch[ií]a)\b/i },
    { name: 'Zipaquirá', regex: /\b(?:zipaquir[aá]|zipa)\b/i },
    { name: 'Apartadó', regex: /\b(?:apartad[oó])\b/i },
    { name: 'Turbo', regex: /\b(?:turbo)\b/i },
    { name: 'Cartago', regex: /\b(?:cartago)\b/i },
    { name: 'Pitalito', regex: /\b(?:pitalito)\b/i },
    { name: 'Ipiales', regex: /\b(?:ipiales)\b/i },
    { name: 'Sogamoso', regex: /\b(?:sogamoso)\b/i },
    { name: 'Duitama', regex: /\b(?:duitama)\b/i },
    { name: 'Girardot', regex: /\b(?:girardot)\b/i }
  ];

  // 4a. Detección de taller y ciudad expresados juntos (ej: "Pj en Bogotá", "La 50 en Medellín", "Taller Central en Cali")
  const workshopCityMatch = raw.match(/^(?:(?:el\s+taller\s+es|se\s+llama|mi\s+taller\s+es|taller)\s+)?([A-Za-z0-9\s#\-\.]{1,35}?)\s+(?:en|de|ubicado\s+en)\s+([A-Za-z0-9\s#\-\.áéíóúÁÉÍÓÚñÑ]{2,30})$/i);
  if (workshopCityMatch) {
    const rawShop = workshopCityMatch[1].trim();
    const rawCity = workshopCityMatch[2].trim();
    const isBadShop = /\b(?:mierda|hp|hpta|hijueputa|gonorrea|marica|carechimba|malparido|no\s+sea|no\s+es|mentira)\b/i.test(rawShop) || /^(?:hola|buenas|soy|yo|si|sí|ok)$/i.test(rawShop);
    if (rawShop.length >= 1 && !isBadShop) {
      const formattedShop = rawShop.toLowerCase().startsWith('taller') || /motos|racing|motor/i.test(rawShop) ? rawShop : `Taller ${rawShop}`;
      extracted.nombre_taller = formattedShop.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      const matchedCity = municipalities.find(m => m.regex.test(rawCity));
      if (matchedCity) {
        extracted.ciudad_taller = matchedCity.name;
      } else if (rawCity.length >= 3 && !/\d/.test(rawCity)) {
        extracted.ciudad_taller = rawCity.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  // 4b. Detección de taller explícito ("se llama La 50", "el taller es Moto Sol")
  const explicitShopMatch = raw.match(/^(?:el\s+taller\s+es|se\s+llama|mi\s+taller\s+es|nombre\s+del\s+taller\s+es)\s+([A-Za-z0-9\s#\-\.]{1,35})$/i);
  if (explicitShopMatch && !extracted.nombre_taller) {
    let s = explicitShopMatch[1].trim();
    const isBadShop = /\b(?:mierda|hp|hpta|hijueputa|gonorrea|marica|carechimba|malparido|no\s+sea|no\s+es|mentira)\b/i.test(s) || /^(?:hola|buenas|soy|yo|si|sí|ok)$/i.test(s);
    if (!isBadShop) {
      s = s.replace(/\s+(?:en|de|ubicado\s+en)\s+.*$/i, '').trim();
      const formattedShop = s.toLowerCase().startsWith('taller') || /motos|racing|motor/i.test(s) ? s : `Taller ${s}`;
      extracted.nombre_taller = formattedShop.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  }

  for (const m of municipalities) {
    if (m.regex.test(lower)) {
      extracted.ciudad_taller = m.name;
      break;
    }
  }

  // Si responde con una sola palabra o frase corta que es ciudad (Ejemplo: "Bogotá", "En Bogotá")
  if (!extracted.ciudad_taller && raw.split(/\s+/).length <= 3) {
    const cleanCityCandidate = raw.replace(/^(?:en|de|en la ciudad de|ciudad)\s+/i, '').trim();
    for (const m of municipalities) {
      if (m.regex.test(cleanCityCandidate)) {
        extracted.ciudad_taller = m.name;
        break;
      }
    }
  }

  // 5. BARRIOS (Medellín y Área Metropolitana)
  const barrios = [
    'Belén', 'Laureles', 'Guayabal', 'Robledo', 'Castilla', 'Aranjuez', 'Manrique',
    'Prado', 'San Javier', 'Buenos Aires', 'Centro', 'La América', 'El Poblado',
    'Floresta', 'Estadio', 'Calasanz', 'Santa Cruz', 'Popular', 'Villa Hermosa',
    'San Cristóbal', 'San Antonio de Prado', 'Niquía', 'Cabañas', 'Boston', 'Ditaires',
    'Santa María', 'Simón Bolívar', 'La Castellana', 'El Dorado'
  ];

  for (const b of barrios) {
    const bRegex = new RegExp(`\\b(?:en\\s+|barrio\\s+)?${b.replace('El ', '')}\\b`, 'i');
    if (bRegex.test(lower)) {
      extracted.barrio_taller = b;
      if (!extracted.ciudad_taller && !sessionContext.ciudad_taller) {
        extracted.ciudad_taller = 'Medellín';
      }
      break;
    }
  }

  // 6. DIRECCIÓN DEL TALLER
  const addrMatch = raw.match(/\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|cra\.|cll\.)\b\s+[0-9a-zA-Z#\s\-\.\°]+/i)
    || raw.match(/\b\d+\s*#\s*\d+[\s\-0-9a-zA-Z]*/i);
  if (addrMatch) {
    extracted.direccion_taller = addrMatch[0].trim();
  }

  // 7. MARCAS DE MOTOS ATENDIDAS
  const brandsList = [
    { name: 'Yamaha', regex: /\byamaha\b/i },
    { name: 'Bajaj', regex: /\b(?:bajaj|pulsar|boxer|discover|platino)\b/i },
    { name: 'AKT', regex: /\b(?:akt|nkd|tt|special)\b/i },
    { name: 'Honda', regex: /\b(?:honda|cb|cbr|xr|wave)\b/i },
    { name: 'Suzuki', regex: /\b(?:suzuki|gixxer|gn|vivax)\b/i },
    { name: 'TVS', regex: /\b(?:tvs|apache|stryker)\b/i },
    { name: 'Hero', regex: /\b(?:hero|eco|hunk)\b/i },
    { name: 'KTM', regex: /\b(?:ktm|duke)\b/i },
    { name: 'Kymco', regex: /\bkymco\b/i },
    { name: 'Victory', regex: /\bvictory\b/i }
  ];

  const detectedBrands = [];
  for (const b of brandsList) {
    if (b.regex.test(lower)) {
      detectedBrands.push(b.name);
    }
  }
  const isGenericBrandsOnly = /^(?:de\s+)?todas$|^(?:de\s+)?todo(?:\s+tipo)?$|^variadas?$|^muchas$/i.test(lower) ||
    (/(?:todas|de todas|variadas|de todo tipo|muchas)/i.test(lower) && detectedBrands.length === 0);

  const isTransitEvading = /\b(?:sitp|transmilenio|metro|buses?|alimentador|pagando\s+pasaje|chiva)\b/i.test(lower);

  if (isTransitEvading) {
    extracted.marcas_motos = null;
    extracted.marcas_genericas = false;
    extracted.es_respuesta_evasiva = true;
  } else if (isGenericBrandsOnly) {
    extracted.marcas_genericas = true;
    if (extracted.protesta_repeticion) {
      extracted.marcas_motos = ['Variadas / Todas'];
    }
  } else if (detectedBrands.length > 0) {
    extracted.marcas_motos = detectedBrands;
  }

  // 8. VOLUMEN DE MOTOS POR SEMANA O DÍA
  // Detecta números directos ("20"), rangos ("entre 15 y 20", "20 a 30"), palabras numéricas ("veinte"), y cualitativos
  const spanishWordNumbers = {
    'un': 1, 'una': 1, 'uno': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10, 'once': 11,
    'doce': 12, 'trece': 13, 'catorce': 14, 'quince': 15, 'dieciseis': 16,
    'diecisiete': 17, 'dieciocho': 18, 'diecinueve': 19, 'veinte': 20,
    'veinticinco': 25, 'treinta': 30, 'cuarenta': 40, 'cincuenta': 50,
    'sesenta': 60, 'setenta': 70, 'ochenta': 80, 'noventa': 90, 'cien': 100
  };

  const isDaily = /\b(?:al\s*d[ií]a|diarias?|por\s*d[ií]a)\b/i.test(raw);
  const isVolumeContext = sessionContext._lastQuestion === 'VOLUMEN' || 
                          sessionContext._lastQuestion === 'VOLUMEN_Y_MARCAS' ||
                          /(?:cu[aá]ntas?|qu[eé]\s+(?:tanto|tantas|cantidad|promedio|flujo|volumen))\s+(?:de\s+)?(?:motos?|m[aá]quinas?)|(?:motos?|m[aá]quinas?)\s+(?:atienden|reciben|llegan|entran)/i.test(sessionContext.lastAssistantMessage || '');

  const rangeMatch = raw.match(/\b(?:entre\s+)?(\d+)\s*(?:a|-|o|y)\s*(\d+)\s*(?:motos?|m[aá]quinas?)?/i);
  const volumeExplicitMatch = raw.match(/(?:como|unas|unos|alrededor\s+de|por\s+ah[ií])?\s*(\d+)\s*(?:motos?|veh[ií]culos?|m[aá]quinas?)?\s*(?:por\s+semana|ala\s+semana|a\s+la\s+semana|semanales|al\s+d[ií]a|diarias)/i)
    || raw.match(/(?:atiendo|recibo|arreglo|llegan|hago|veo|entran)\s*(?:como|unas|unos)?\s*(\d+)\s*(?:motos?)?(?:\s*(?:por|a\s*la)\s*semana|\s*al\s*d[ií]a)?/i)
    || raw.match(/\b(\d+)\s*(?:motos?|m[aá]quinas?)\b/i);

  const standaloneNumMatch = raw.match(/\b(?:unas?|unos?|como|por\s+ah[ií]|alrededor\s+de|m[aá]s\s+o\s+menos)?\s*(\d{1,3})\s*(?:motos?)?\b/i);

  let wordNum = null;
  for (const [w, n] of Object.entries(spanishWordNumbers)) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(raw)) {
      wordNum = n;
      break;
    }
  }

  if (isTransitEvading) {
    // Si menciona transporte público o evasivas, no asignar volumen espurio
    extracted.motos_por_semana = null;
  } else if (rangeMatch && (isVolumeContext || /\bmotos?\b/i.test(raw) || isDaily || /semana/i.test(raw))) {
    const min = rangeMatch[1];
    const max = rangeMatch[2];
    extracted.motos_por_semana = isDaily ? `${min} a ${max} motos al día` : `${min} a ${max} motos/semana`;
  } else if (volumeExplicitMatch && volumeExplicitMatch[1]) {
    const num = volumeExplicitMatch[1];
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${num} motos al día` : `${num} motos/semana`;
  } else if (isVolumeContext && standaloneNumMatch && standaloneNumMatch[1]) {
    const num = standaloneNumMatch[1];
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${num} motos al día` : `${num} motos/semana`;
  } else if (isVolumeContext && wordNum) {
    extracted.motos_por_semana = isDaily ? `Aproximadamente ${wordNum} motos al día` : `${wordNum} motos/semana`;
  } else if (/bastantes|muchas|harto|full|bastante movimiento|buen flujo/i.test(lower) && (isVolumeContext || /motos?/i.test(lower))) {
    extracted.motos_por_semana = 'Alta afluencia (+30 motos/semana)';
  } else if (/pocas|poquitas|bajo|suave|despacio/i.test(lower) && isVolumeContext) {
    extracted.motos_por_semana = 'Baja afluencia (menos de 10 motos/semana)';
  }

  // 9. TIPOS DE REPUESTOS Y REPUESTOS FRECUENTES
  const partsList = [
    { name: 'Kits de arrastre', regex: /\b(?:kit\s+d[e]?\s+arrastre|arrastre|cadenas?|pi[ñn][oó]n|corona)\b/i },
    { name: 'Pastillas de freno', regex: /\b(?:pastillas?(?:\s+de\s+freno)?|frenos?|bandas?|discos?)\b/i },
    { name: 'Partes de motor', regex: /\b(?:motor|motores|cilindros?|pist[oó]n|pistones|anillos|v[aá]lvulas?|empaques?)\b/i },
    { name: 'Lubricación / Filtros', regex: /\b(?:aceites?|filtros?|lubricantes?)\b/i },
    { name: 'Suspensión', regex: /\b(?:suspensi[oó]n|amortiguadores?|retenes|retenedores)\b/i },
    { name: 'Electricidad / Baterías', regex: /\b(?:bater[ií]as?|buj[ií]as?|bobinas?|bombillos?|luces|el[eé]ctrico|electricidad)\b/i },
    { name: 'Llantas / Neumáticos', regex: /\b(?:llantas?|neum[aá]ticos?|rines)\b/i },
    { name: 'Guayas y mandos', regex: /\b(?:guayas?|cables?|mandos?|manecillas?)\b/i },
    { name: 'Rodamientos', regex: /\b(?:rodamientos?|balineras?|cunas?)\b/i }
  ];

  const detectedParts = [];
  for (const p of partsList) {
    if (p.regex.test(lower)) {
      detectedParts.push(p.name);
    }
  }
  const isGenericPartsOnly = /^(?:de\s+)?todo$|^variados?$|^lo que llegue$/i.test(lower) ||
    (/(?:de todo|variados|lo que llegue)/i.test(lower) && detectedParts.length === 0);

  // Distinción semántica de polisemia de "rotar": "roto por las estaciones" = desplazamiento, NO repuestos
  const isLocationRotation = /\broto\s+(?:por|en|entre|turnos?)\b/i.test(lower) && !/\b(?:repuestos?|piezas?|frenos?|arrastre|aceite|bater[ií]a)\b/i.test(lower);

  if (isLocationRotation || isTransitEvading) {
    extracted.repuestos_frecuentes = null;
    extracted.repuestos_genericos = false;
  } else if (isGenericPartsOnly) {
    extracted.repuestos_genericos = true;
    if (extracted.protesta_repeticion) {
      extracted.repuestos_frecuentes = ['Variados / De todo'];
    }
  } else if (detectedParts.length > 0) {
    extracted.repuestos_frecuentes = detectedParts;
  }

  // 10. ROLES EN EL TALLER
  // Detecta dueño, mecánico, o rol dual con soporte para jerga colombiana ("la que lo comanda", "el patrón", etc.)
  const isOwner = /\b(?:due[ñn]o|due[ñn]a|propietari[oa]|patr[oó]n|patrona|jefe|jefa|socio|socia|creador|fundador|el\s+taller\s+es\s+m[ií]o|es\s+m[ií]o|la\s+que\s+(?:lo\s+)?comanda|el\s+que\s+(?:lo\s+)?comanda|yo\s+(?:lo\s+)?comando|yo\s+mando|la\s+que\s+manda|el\s+que\s+manda|el\s+mero\s+mero|la\s+mera\s+mera|el\s+duro|la\s+dura)\b/i.test(lower);
  const isMechanic = /\b(?:mec[aá]nico|empleado|trabajador|t[eé]cnico|yo\s+arreglo|arreglo\s+las\s+motos|las\s+arreglo\s+yo)\b/i.test(lower);
  const isBoth = /\b(?:ambas|las\s+dos|ambos|ambas\s+cosas|due[ñn]o\s+y\s+mec[aá]nico|propietario\s+y\s+mec[aá]nico)\b/i.test(lower) ||
                 (isOwner && isMechanic);

  if (isBoth) {
    extracted.relacion_taller = 'Propietario y Mecánico';
  } else if (isOwner) {
    extracted.relacion_taller = 'Propietario';
  } else if (isMechanic) {
    extracted.relacion_taller = 'Mecánico';
  }

  // 11. EQUIPO / PERSONAL EN EL TALLER
  const teamMatch = raw.match(/somos\s*(\d+|dos|tres|cuatro|cinco)\s*mec[aá]nicos?/i)
    || raw.match(/(?:somos|trabajamos)\s*(\d+)\s*(?:personas|en\s+el\s+taller)?/i);
  if (teamMatch) {
    extracted.equipo_taller = teamMatch[0];
  } else if (/trabajo\s+solo|estoy\s+solo/i.test(lower)) {
    extracted.equipo_taller = 'Trabaja solo';
  }

  // 12. ESPECIALIDAD TÉCNICA
  const specs = [];
  if (/de todo|mec[aá]nica general|reparaci[oó]n general|todo/i.test(lower)) specs.push('Mecánica general');
  if (/motor|motores|ajuste|anillado/i.test(lower)) specs.push('Motor / 4T');
  if (/inyecci[oó]n|electr[oó]nica|inyeccion electr[oó]nica/i.test(lower)) specs.push('Inyección electrónica');
  if (/frenos|suspensi[oó]n/i.test(lower)) specs.push('Frenos / Suspensión');
  if (/electricidad|el[eé]ctrico/i.test(lower)) specs.push('Electricidad');
  if (specs.length > 0) {
    extracted.especialidad = specs;
  }

  // 13. MARCAS DE REPUESTOS RECOMENDADAS O USADAS (Casarella, Nitrox, originales, etc.)
  const repBrandsList = ['Casarella', 'NITROX', 'Yamaha', 'Honda', 'AKT', 'Bajaj', 'DID', 'Choho', 'Ichiban', 'Repsol', 'Motul', 'Castrol', 'NGK'];
  const detectedRepBrands = [];
  for (const rb of repBrandsList) {
    if (new RegExp(`\\b${rb}\\b`, 'i').test(lower)) {
      detectedRepBrands.push(rb);
    }
  }
  if (detectedRepBrands.length > 0) {
    extracted.marcas_repuestos_usadas = detectedRepBrands;
    extracted.frecuencia_recomendacion = 'Frecuentemente';
    if (!extracted.quien_decide_repuesto) extracted.quien_decide_repuesto = 'Mecánico';
  }

  const isAskingRec = sessionContext._askingRecommendBrands || sessionContext._lastQuestion === 'MARCA_RECOMENDADA' || sessionContext._lastQuestion === 'REPUESTOS_Y_MARCA';
  if (isAskingRec) {
    if (/^(?:no|ninguna|para\s+nada|no\s+recomiendo|no\s+manejo)$/i.test(lower) || /\b(?:no\s+recomiendo|ninguna\s+marca|no\s+tengo\s+preferencia)\b/i.test(lower)) {
      extracted.frecuencia_recomendacion = 'Nunca';
      extracted.marcas_repuestos_usadas = ['Ninguna'];
      extracted.quien_decide_repuesto = 'Cliente';
    } else if (/(?:cliente|ellos\s+traen|los\s+trae\s+el\s+cliente|el\s+due[ñn]o)/i.test(lower)) {
      extracted.frecuencia_recomendacion = 'Algunas veces';
      extracted.quien_decide_repuesto = 'Cliente';
      if (!extracted.marcas_repuestos_usadas) extracted.marcas_repuestos_usadas = ['La que traiga el cliente'];
    }
  }

  // Criterio de compra
  if (/m[aá]s\s+econ[oó]mico|donde\s+me\s+salga\s+m[aá]s\s+barato|precio|econom[ií]a/i.test(lower)) {
    extracted.criterio_compra = 'Precio / Economía';
  } else if (/calidad|original|garant[ií]a|durabilidad/i.test(lower)) {
    extracted.criterio_compra = 'Calidad y Garantía';
  }

  // 14. CONOCIMIENTO DE LA MARCA NITROX (Sí / No)
  if (/(?:no\s+(?:lo\s+|la\s+|los\s+)?conozco|primera\s+vez|no\s+he\s+escuchado|ni\s+idea|^no\b|para\s+nada|nunca\s+los\s+he\s+visto)/i.test(lower)) {
    if (sessionContext._askingNitrox || sessionContext._lastQuestion === 'NITROX_EXP_INTERES' || /\bnitrox\b/i.test(lower) || lower.split(/\s+/).length <= 4) {
      extracted.conoce_nitrox = 'No';
      extracted.ha_usado_nitrox = 'No';
    }
  } else if (/\bnitrox\b/i.test(lower) || ((sessionContext._askingNitrox || sessionContext._lastQuestion === 'NITROX_EXP_INTERES') && /^(?:s[ií]|claro|de\s+una|obvio)/i.test(lower))) {
    extracted.conoce_nitrox = 'Sí';
  }

  // 15. INTERÉS EN BENEFICIOS Y RECOMENDAR NITROX (Recomendar, Premios, Muestras, Catálogo)
  const isAskingRecNitrox = sessionContext._askingRecommendNitrox || sessionContext._lastQuestion === 'RECOMENDAR_NITROX' || sessionContext._lastQuestion === 'OFERTA_MUESTRAS' || sessionContext._lastQuestion === 'NITROX_EXP_INTERES';
  if (isAskingRecNitrox && /^(?:s[ií]|claro|de\s+una|h[aá]gale|obvio|por\s+supuesto|me\s+gustar[ií]a|s[ií]\s+claro)$/i.test(lower)) {
    extracted.recomendaria_nitrox = 'Definitivamente sí';
    extracted.quiere_muestras = 'Sí';
    extracted.interes_comercial_detalles = 'Interés en recomendar NITROX y recibir muestras/premios';
  } else if (isAskingRecNitrox && /^(?:no|paso|no\s+gracias|no\s+me\s+interesa)$/i.test(lower)) {
    extracted.recomendaria_nitrox = 'No';
    extracted.quiere_muestras = 'No';
  } else if (/\b(?:muestras|cat[aá]logo|capacitaci[oó]n|capacitaciones|conocer\s+el\s+cat[aá]logo|recibir\s+muestras|premios|beneficios)\b/i.test(lower) ||
      (/\b(?:me\s+interesa|me\s+gustar[ií]a|claro|de\s+una|h[aá]gale|obvio|por\s+supuesto|s[ií])\b/i.test(lower) && (sessionContext._offeringNitrox || sessionContext._askingRecommendNitrox))) {
    extracted.quiere_muestras = 'Sí';
    extracted.interes_comercial_detalles = 'Interés manifestado en muestras de repuestos y catálogo oficial';
  }

  // 16. CONTACTO: TELÉFONOS CELULARES (WhatsApp y alterno)
  const mobMatches = [...raw.replace(/[\s.\-()]/g, ' ').matchAll(/(?:\+?57\s*)?(3\d{9})(?!\d)/g)];
  if (mobMatches.length > 0) {
    extracted.celular_whatsapp = '57' + mobMatches[0][1];
    if (mobMatches.length > 1) {
      extracted.telefono_alterno = '57' + mobMatches[1][1];
    }
  }

  // 17. CONTACTO: CORREO ELECTRÓNICO
  const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    extracted.correo = emailMatch[0].toLowerCase();
  }

  // 18. DOCUMENTO DE IDENTIDAD: CÉDULA / NIT (Extracción estricta sin contaminar con celulares)
  const explicitId = raw.match(/\b(?:c[eé]dula|cc|c\.c\.|nit|documento)\b[:\s#]*(\b\d{7,10}(?:-\d)?\b)/i);
  if (explicitId) {
    extracted.cedula = explicitId[1];
  } else if ((sessionContext._askingCedula || sessionContext._lastQuestion === 'CEDULA') && !extracted.correo) {
    const candidateMatch = raw.match(/\b\d{7,10}\b/);
    if (candidateMatch) {
      const num = candidateMatch[0];
      // Solo asignar si NO coincide con un celular extraído en este mensaje
      if (!extracted.celular_whatsapp || !extracted.celular_whatsapp.includes(num)) {
        extracted.cedula = num;
      }
    }
  }

  // 19. HABEAS DATA - AUTORIZACIÓN LEGAL DE TRATAMIENTO DE DATOS
  if (sessionContext._waitingHabeasData || sessionContext._lastQuestion === 'HABEAS_DATA') {
    if (/(?:no\s*gracias|no\s*acepto|no\s*autorizo|^no\b|para\s*nada|negativo)/i.test(lower)) {
      extracted.autorizacion_habeas_data = false;
    } else if (/(?:s[ií]|acepto|autorizo|claro|de\s+una|h[aá]gale|con\s+gusto|de\s+acuerdo|ok|listo)/i.test(lower)) {
      extracted.autorizacion_habeas_data = true;
    }
  }

  return extracted;
}

/**
 * Pipeline integral de NLP en Español para MATEO.
 * Ejecuta: Normalización -> Tokenización -> Lematización -> Extracción Semántica.
 */
function processNlpPipeline(rawText, sessionContext = {}) {
  const norm = normalizeText(rawText);
  const tokenInfo = tokenize(norm.normalized);
  const lemmas = lemmatize(tokenInfo, norm.normalized);
  const entities = extractSemanticEntities(norm.normalized, sessionContext);

  return {
    originalText: norm.original,
    normalizedText: norm.normalized,
    tokens: tokenInfo.rawTokens,
    multiWords: tokenInfo.multiWords,
    lemmas: lemmas,
    entities: entities
  };
}

module.exports = {
  normalizeText,
  tokenize,
  lemmatize,
  extractSemanticEntities,
  processNlpPipeline
};
