const admin = require('firebase-admin');
const { normalizeMechanicData, calculateMechanicScore, calculateNitroxLevel } = require('./scoring');
let _processGeminiBrainTurn = null;
function getProcessGeminiBrainTurn() {
  if (!_processGeminiBrainTurn) {
    const { processGeminiBrainTurn } = require('./gemini_brain');
    _processGeminiBrainTurn = processGeminiBrainTurn;
  }
  return _processGeminiBrainTurn;
}

function triggerMlAnalysis(phoneNumber, session) {
  setImmediate(async () => {
    try {
      const { analyzeConversationAsync } = require('./ml_service');
      analyzeConversationAsync(phoneNumber, session);
    } catch (e) {
      console.warn('[ML ASYNC INIT ERROR]', e.message);
    }
  });
}

// Initialize Firebase Admin for Firestore
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: 'agente-nitrox'
    });
  } catch (e) {
    // Local fallback
  }
}

const memoryCache = {};

// Helper to detect generic greetings (e.g. "Hola", "Buenas tardes", "Hola como estas")
function isPureGreeting(text) {
  const clean = (text || '').trim().toLowerCase().replace(/[.,!¡?¿]+/g, ' ').trim();
  if (/(?:taller|motos|moto|repuestos|llamo|nombre|soy|medellin|bello|itagui|afiliar|registro|inscribir|info|informacion|información)/i.test(clean)) {
    return false;
  }
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const greetingTokens = /^(?:hola|buenas|buenos|dia|dias|día|días|tarde|tardes|noche|noches|que|qué|mas|más|tal|como|cómo|estas|estás|esta|está|va|todo|bien|amigo|hermano|mateo|sr|señor|senor|nitrox|asesor|saludos|alo|aló|hey)$/i;
  return words.every(w => greetingTokens.test(w));
}

function isGreetingResponse(text) {
  const clean = (text || '').trim().toLowerCase().replace(/[.,!¡?¿]+/g, ' ').trim();
  if (/(?:taller|motos|moto|repuestos|llamo|nombre|soy)/i.test(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  const tokens = /^(?:bien|muy|todo|gracias|y|tu|tú|vos|usted|hermano|amigo|dios|a|orden|excelente|aca|acá|trabajando|ahi|ahí|vamos|buenas|hola|saludos|al|pelo|firme)$/i;
  return words.every(w => tokens.test(w));
}

function isGreeting(text) {
  return isPureGreeting(text) || isGreetingResponse(text) || /^(?:info|informacion|afiliacion|afiliar|red nitrox)[\s.,!]*$/i.test((text || '').trim());
}

const commonFirstNames = /^(?:carlos|juan|walter|luis|andres|andrés|jose|josé|pedro|jorge|mario|diego|david|daniel|alexander|javier|fernando|wilson|cristian|camilo|sebastian|sebastián|santiago|felipe|mateo|julian|julián|victor|víctor|gabriel|oscar|óscar|miguel|alvaro|álvaro|john|jhon|fabio|rodrigo|hernan|hernán|jaime|gustavo|miller|edison|edwin|fredy|freddy|hector|héctor|yeison|jhonatan|brayan|kevin|faber|robinson|mauricio|guillermo|alejandro|esteban|stiven|duvan|duván|leonardo|cesar|césar|raul|raúl|nelson|humberto|alonso|orlando|ricardo|sergio|manuel|albeiro|dario|darío)\b/i;
const workshopKeywords = /\b(?:taller|moto taller|motos|moto|repuestos|racing|serviteca|servi|garage|mecanica|mecánica)\b/i;

// Helper to count words
function countWords(str) {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// Helper to extract and clean personal name
function cleanPersonName(str) {
  if (!str) return '';
  let s = str.trim();
  if (isPureGreeting(s) || isGreetingResponse(s)) return '';
  s = s.replace(/^(?:hola|buenas|buenos dias|buenas tardes|soy|me llamo|mi nombre es|yo soy|yo me llamo)\s+/gi, '');
  s = s.replace(/(?:taller|motos|repuestos).*$/gi, '').trim();
  s = s.replace(/\s+(?:y|de|del)$/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (isPureGreeting(s) || isGreetingResponse(s)) return '';
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && /^(hola|buenas|quiero|taller|motos|info)$/i.test(words[0]))) return '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Helper to extract and clean workshop name
function cleanWorkshopName(str) {
  if (!str) return '';
  let s = str.trim();
  if (/^(?:no tengo taller|a domicilio|independiente|trabajo a domicilio|particular)/i.test(s)) {
    return 'Mecánico Independiente / A domicilio';
  }
  // Remove introductory and trailing filler
  s = s.replace(/^(?:y\s+)?(?:mi\s+taller\s+es|mi\s+taller\s+se\s+llama|el\s+taller\s+es|el\s+taller\s+se\s+llama|se\s+llama\s+el\s+taller|se\s+llama|el\s+taller|taller:\s*|es\s+el\s+taller|del\s+taller)\s+/gi, '').trim();
  s = s.replace(/\s+(?:el\s+taller|mi\s+taller)$/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (!workshopKeywords.test(s)) {
    s = 'Taller ' + s;
  }
  return s.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Helper to parse Name & Workshop if provided together or separately
function parseNameAndWorkshop(raw) {
  const clean = (raw || '').trim();
  if (!clean || isGreeting(clean)) return { name: '', workshop: '', ambiguous: null };

  // 1. Explicit multi-line input
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const isW0 = workshopKeywords.test(lines[0]);
    const isW1 = workshopKeywords.test(lines[1]);
    if (isW1 && !isW0) {
      return { name: cleanPersonName(lines[0]), workshop: cleanWorkshopName(lines[1]), ambiguous: null };
    } else if (isW0 && !isW1) {
      return { name: cleanPersonName(lines[1]), workshop: cleanWorkshopName(lines[0]), ambiguous: null };
    }
  }

  // 2. Pattern: Person first, then workshop with "se llama", "el taller es", "taller":
  // e.g. "Soy Sergio Se Llama Panama El Taller", "Soy Sergio y el taller es Panama", "Sergio, taller Panama", "Sergio se llama Panama el taller"
  const personFirstMatch = clean.match(/^(?:hola|buenas|buenos dias)?\s*(?:yo\s+soy|soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]+)?)\s*[,;]?\s*(?:y\s+)?(?:se\s+llama|el\s+taller\s+es|el\s+taller\s+se\s+llama|mi\s+taller\s+es|mi\s+taller\s+se\s+llama|el\s+taller\s+de\s+nombre|taller)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+?)(?:\s+el\s+taller)?$/i)
    || clean.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s*[,;]?\s*(?:y\s+)?(?:se\s+llama|el\s+taller\s+es|el\s+taller\s+se\s+llama|mi\s+taller\s+es|mi\s+taller\s+se\s+llama|el\s+taller\s+de\s+nombre|taller)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+?)(?:\s+el\s+taller)?$/i);
  if (personFirstMatch && personFirstMatch[1].trim() && personFirstMatch[2].trim()) {
    const nameCand = personFirstMatch[1].trim();
    const shopCand = personFirstMatch[2].trim();
    if (!workshopKeywords.test(nameCand) && !/^(?:el|la|los|las|un|una|mi|tu|su)$/i.test(nameCand) && (commonFirstNames.test(nameCand) || /soy|me llamo|yo soy|mi nombre/i.test(clean))) {
      return { name: cleanPersonName(nameCand), workshop: cleanWorkshopName(shopCand), ambiguous: null };
    }
  }

  // 3. Pattern: Workshop first, then person:
  // e.g. "Se llama Panama el taller y yo soy Sergio", "El taller se llama Panama y me llamo Sergio", "Taller Panama, soy Sergio"
  const shopFirstMatch = clean.match(/^(?:se\s+llama|el\s+taller\s+es|el\s+taller\s+se\s+llama|mi\s+taller\s+es|mi\s+taller\s+se\s+llama|taller)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+?)(?:\s+el\s+taller)?\s*[,;]?\s*(?:y\s+)?(?:yo\s+soy|soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+)$/i);
  if (shopFirstMatch && shopFirstMatch[1].trim() && shopFirstMatch[2].trim()) {
    return { name: cleanPersonName(shopFirstMatch[2]), workshop: cleanWorkshopName(shopFirstMatch[1]), ambiguous: null };
  }

  // 4. Pattern: "Soy [Nombre] de/del [Taller]"
  const deMatch = clean.match(/^(?:soy|me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:de|del|y mi taller es|y el taller es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)$/i);
  if (deMatch && deMatch[1].trim() && deMatch[2].trim()) {
    return { name: cleanPersonName(deMatch[1]), workshop: cleanWorkshopName(deMatch[2]), ambiguous: null };
  }

  // 5. Pattern with commas or "y":
  if (clean.includes(',') || /\s+y\s+/i.test(clean)) {
    const parts = clean.split(/,|\s+y\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const isW0 = workshopKeywords.test(parts[0]);
      const isW1 = workshopKeywords.test(parts[1]);
      if (isW1 && !isW0) {
        return { name: cleanPersonName(parts[0]), workshop: cleanWorkshopName(parts[1]), ambiguous: null };
      } else if (isW0 && !isW1) {
        return { name: cleanPersonName(parts[1]), workshop: cleanWorkshopName(parts[0]), ambiguous: null };
      }
    }
  }

  // 6. If two parts separated by 'de' or 'del' without 'soy/me llamo', check if part1 is a known person name AND part2 has workshop word
  const deParts = clean.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:de|del)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)$/i);
  if (deParts && commonFirstNames.test(deParts[1].trim().split(/\s+/)[0]) && workshopKeywords.test(deParts[2])) {
    return { name: cleanPersonName(deParts[1]), workshop: cleanWorkshopName(deParts[2]), ambiguous: null };
  }

  // 7. Explicit single person or single workshop patterns
  const singleNameMatch = clean.match(/^(?:yo\s+soy|soy|me\s+llamo|mi\s+nombre\s+es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+)$/i);
  if (singleNameMatch && !workshopKeywords.test(singleNameMatch[1])) {
    return { name: cleanPersonName(singleNameMatch[1]), workshop: '', ambiguous: null };
  }

  const singleWorkshopMatch = clean.match(/^(?:mi\s+taller\s+es|el\s+taller\s+es|mi\s+taller\s+se\s+llama|el\s+taller\s+se\s+llama|taller:\s*)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)$/i);
  if (singleWorkshopMatch) {
    return { name: '', workshop: cleanWorkshopName(singleWorkshopMatch[1]), ambiguous: null };
  }

  // 8. General single entity check
  const lower = clean.toLowerCase();
  if (workshopKeywords.test(lower) && !/(?:soy|me llamo|mi nombre|yo soy)/i.test(lower)) {
    return { name: '', workshop: cleanWorkshopName(clean), ambiguous: null };
  }

  const words = clean.split(/\s+/).filter(Boolean);
  if (commonFirstNames.test(words[0]) && words.length <= 3 && !/(?:dorado|racing|garage|motor|repuestos|leon|león|taller)/i.test(lower)) {
    return { name: cleanPersonName(clean), workshop: '', ambiguous: null };
  }

  // 9. Ambiguous single entity (like "León Del Dorado")
  return { name: '', workshop: '', ambiguous: clean };
}

function extractEntities(text, sessionData) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase().replace(/[.,!¡?¿]+/g, ' ');
  const isProtest = /(?:ya\s+(?:me\s+)?hab[ií]as|ya\s+te\s+(?:dije|respond[ií])|eso\s+ya|ya\s+lo\s+dije|ya\s+respond[ií]|pregunta\s+ya)/i.test(lower);
  const updates = {};

  if (isProtest) {
    if (sessionData._lastQuestion === 'ESPECIALIDAD' || sessionData._lastQuestion === 'ROL_Y_ESPECIALIDAD') {
      updates.especialidad = ['Mecánica general'];
    } else if (sessionData._lastQuestion === 'REPUESTOS' || sessionData._lastQuestion === 'REPUESTOS_Y_MARCA') {
      updates.repuestos_frecuentes = ['Variados / De todo'];
    } else if (sessionData._lastQuestion === 'MARCAS_MOTOS' || sessionData._lastQuestion === 'VOLUMEN_Y_MARCAS') {
      updates.marcas_motos = ['Variadas / Todas'];
    } else if (sessionData._lastQuestion === 'MARCA_RECOMENDADA') {
      updates.marcas_repuestos_usadas = ['Variadas / Originales'];
      if (!sessionData.quien_decide_repuesto) updates.quien_decide_repuesto = 'Mecánico';
    } else if (sessionData._lastQuestion === 'VOLUMEN') {
      updates.motos_por_semana = '15 motos/semana';
    } else if (sessionData._lastQuestion === 'CANAL_COMPRA') {
      updates.canal_compra = 'Distribuidor y almacén';
    }
  }

  // Handling clarification of ambiguous name/workshop
  if (sessionData._lastQuestion === 'CLARIFY_NOMBRE_O_TALLER') {
    const amb = sessionData._ambiguousName || '';
    if (/(?:del taller|el taller|taller|nombre del taller|es el taller)/i.test(lower)) {
      updates.nombre_taller = cleanWorkshopName(amb);
      delete sessionData._ambiguousName;
      const namePart = raw.replace(/(?:es\s+el\s+nombre\s+del\s+taller|es\s+el\s+taller|del\s+taller|el\s+taller|taller|nombre\s+del\s+taller|es\s+de\s+mi\s+taller|de\s+mi\s+taller)[,;.\s]*/gi, '')
                          .replace(/^(?:yo\s+soy|yo\s+me\s+llamo|me\s+llamo|soy|mi\s+nombre\s+es|y\s+yo|y|mi\s+nombre)\s+/gi, '')
                          .trim();
      if (namePart && namePart.length >= 2 && !/(?:si|sí|ok|listo|no)/i.test(namePart)) {
        updates.nombres_apellidos = cleanPersonName(namePart);
      }
    } else if (/(?:mi nombre|es mi nombre|soy yo|el mio|el mío|nombre mío|nombre personal)/i.test(lower)) {
      updates.nombres_apellidos = cleanPersonName(amb);
      delete sessionData._ambiguousName;
      const workshopPart = raw.replace(/(?:es\s+mi\s+nombre|mi\s+nombre|soy\s+yo|el\s+mio|el\s+mío)[,;.\s]*/gi, '')
                              .replace(/^(?:y\s+el\s+taller\s+es|el\s+taller\s+es|mi\s+taller\s+es|taller|y)\s+/gi, '')
                              .trim();
      if (workshopPart && workshopPart.length >= 2 && !/(?:si|sí|ok|listo|no)/i.test(workshopPart)) {
        updates.nombre_taller = cleanWorkshopName(workshopPart);
      }
    }
  }

  // 1. Name & Workshop if missing
  if (!sessionData.nombres_apellidos || !sessionData.nombre_taller) {
    if (sessionData._lastQuestion === 'NOMBRE' && !sessionData.nombres_apellidos) {
      const parsed = parseNameAndWorkshop(raw);
      if (parsed.name) {
        updates.nombres_apellidos = parsed.name;
        if (parsed.workshop && !sessionData.nombre_taller) updates.nombre_taller = parsed.workshop;
      } else {
        const p = cleanPersonName(raw);
        if (p) updates.nombres_apellidos = p;
      }
    } else if (sessionData._lastQuestion === 'TALLER' && !sessionData.nombre_taller) {
      const parsed = parseNameAndWorkshop(raw);
      if (parsed.workshop) {
        updates.nombre_taller = parsed.workshop;
        if (parsed.name && !sessionData.nombres_apellidos) updates.nombres_apellidos = parsed.name;
      } else {
        const w = cleanWorkshopName(raw);
        if (w) updates.nombre_taller = w;
      }
    } else if (sessionData._lastQuestion === 'NOMBRE_Y_TALLER' || !sessionData._lastQuestion) {
      const parsed = parseNameAndWorkshop(raw);
      if (parsed.ambiguous) {
        updates._ambiguousName = parsed.ambiguous;
      } else {
        if (parsed.name && !sessionData.nombres_apellidos) updates.nombres_apellidos = parsed.name;
        if (parsed.workshop && !sessionData.nombre_taller) updates.nombre_taller = parsed.workshop;
      }
    }
  }

  // 2. City / Municipality
  if (/bello/i.test(lower)) updates.ciudad_taller = 'Bello';
  else if (/itagui|itaguí/i.test(lower)) updates.ciudad_taller = 'Itagüí';
  else if (/envigado/i.test(lower)) updates.ciudad_taller = 'Envigado';
  else if (/sabaneta/i.test(lower)) updates.ciudad_taller = 'Sabaneta';
  else if (/estrella/i.test(lower)) updates.ciudad_taller = 'La Estrella';
  else if (/caldas/i.test(lower)) updates.ciudad_taller = 'Caldas';
  else if (/copacabana/i.test(lower)) updates.ciudad_taller = 'Copacabana';
  else if (/girardota/i.test(lower)) updates.ciudad_taller = 'Girardota';
  else if (/medellin|medellín/i.test(lower)) updates.ciudad_taller = 'Medellín';
  else if (sessionData._lastQuestion === 'UBICACION' || sessionData._lastQuestion === 'BARRIO') {
    if (!sessionData.ciudad_taller && !updates.ciudad_taller) {
      updates.ciudad_taller = 'Medellín';
    }
  }
  if (updates.ciudad_taller) updates.ciudad_residencia = updates.ciudad_taller;

  // 3. Role detection (Relación con el taller)
  const isOwner = /\b(?:propi?e?r?t[a-z]*|duen[a-z]*|dueñ[a-z]*|patr[oó]n|socio|creador|fundador|el taller es m[ií]o|es m[ií]o|yo lo manejo)\b/i.test(lower);
  const isMechanic = /\b(?:mec[aá]nic[a-z]*|mecanic[a-z]*|emplead[a-z]*|trabajad[a-z]*|t[eé]cnic[a-z]*|las arreglo yo|yo arreglo)\b/i.test(lower);
  const isBoth = /\b(?:ambas|las dos|ambos|ambas cosas|las 2)\b/i.test(lower) || (isOwner && isMechanic);

  if (isBoth) {
    updates.relacion_taller = 'Propietario y Mecánico';
  } else if (isOwner) {
    updates.relacion_taller = 'Propietario';
  } else if (isMechanic) {
    updates.relacion_taller = 'Mecánico';
  } else if (/socio|copropietario/i.test(lower)) {
    updates.relacion_taller = 'Socio';
  }

  // 4. Dirección (Address)
  const addrMatch = raw.match(/\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|cra\.|cll\.)\b\s+[0-9a-zA-Z#\s\-\.\°]+/i)
    || raw.match(/\b\d+\s*#\s*\d+[\s\-0-9a-zA-Z]*/i);
  if (addrMatch) {
    updates.direccion_taller = addrMatch[0].trim();
  } else if (sessionData._lastQuestion === 'DIRECCION' && !sessionData.direccion_taller) {
    if (isOwner || isMechanic || isBoth) {
      updates.direccion_taller = `Sector ${sessionData.barrio_taller || 'Medellín'}`;
    } else if (/\d/.test(raw) || /\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|esquina|con|frente|cerca)\b/i.test(lower)) {
      updates.direccion_taller = raw;
    } else if (isProtest || /no\s*(?:me\s*la\s*s[eé]|s[eé]|me\s*acuerdo|tengo)|por\s+el|cerca|parque/i.test(lower) || raw.trim().length >= 2) {
      updates.direccion_taller = raw.trim().length >= 2 ? raw.trim() : `Sector ${sessionData.barrio_taller || 'Medellín'}`;
    }
  }

  // 5. Barrio (Only if asked or explicit 'barrio' keyword, NEVER during NOMBRE_Y_TALLER)
  const isLocationTurn = sessionData._lastQuestion === 'UBICACION' || sessionData._lastQuestion === 'BARRIO';
  const hasExplicitBarrioWord = /\b(?:barrio|en el barrio)\b/i.test(lower);
  if (isLocationTurn || hasExplicitBarrioWord) {
    const barrioMatch = raw.match(/(?:en\s+|barrio\s+)?\b(bel[eé]n|laureles|guayabal|robledo|castilla|aranjuez|manrique|prado|san javier|buenos aires|centro|la am[eé]rica|poblado|floresta|estadio|calasanz|santa cruz|popular|villa hermosa|san crist[oó]bal|san antonio de prado|niqu[ií]a|caba[ñn]as|boston|ditaires|santa mar[ií]a|sim[oó]n bol[ií]var|la castellana|el dorado|dorado)\b/i);
    if (barrioMatch) {
      const b = barrioMatch[1];
      updates.barrio_taller = b.charAt(0).toUpperCase() + b.slice(1).toLowerCase();
      if (updates.barrio_taller.toLowerCase() === 'dorado') updates.barrio_taller = 'El Dorado';
    } else if (sessionData._lastQuestion === 'BARRIO' && !sessionData.barrio_taller) {
      updates.barrio_taller = raw;
    } else if (sessionData._lastQuestion === 'UBICACION' && !sessionData.barrio_taller && !updates.barrio_taller) {
      if (!updates.direccion_taller) {
        updates.barrio_taller = raw.replace(/^(?:en|el|barrio)\s+/i, '').trim();
      } else if (addrMatch) {
        const rem = raw.replace(addrMatch[0], '').replace(/^(?:en|el|barrio|,|\s)+/i, '').replace(/[,.\s]+$/, '').trim();
        if (rem && rem.length > 2) {
          updates.barrio_taller = rem;
        }
      }
    }
  }

  // 6. Professional Specialty (Perfil Profesional y Especialidad)
  const isSpecQuestion = sessionData._lastQuestion === 'ESPECIALIDAD' || sessionData._lastQuestion === 'ROL_Y_ESPECIALIDAD';
  const specs = Array.isArray(sessionData.especialidad) ? [...sessionData.especialidad] : [];
  if (/motor|motores|ajuste|anillado|culata/i.test(lower) && !specs.includes('Motor / 4T')) specs.push('Motor / 4T');
  if (/2\s*t|2\s*tiempos/i.test(lower) && !specs.includes('2T')) specs.push('2T');
  if (/4\s*t|4\s*tiempos/i.test(lower) && !specs.includes('4T') && !specs.includes('Motor / 4T')) specs.push('4T');
  if (/freno|frenos|pastilla|banda|disco|suspensi[oó]n|amortiguador/i.test(lower) && !specs.includes('Frenos / Suspensión')) specs.push('Frenos / Suspensión');
  if (/electricidad|el[eé]ctrico|electrico|inyecci[oó]n|inyeccion|electr[oó]nica|bobina|bater[ií]a/i.test(lower) && !specs.includes('Electricidad / Inyección electrónica')) specs.push('Electricidad / Inyección electrónica');
  if (/general|de todo|todas|todo|mec[aá]nica general|reparaci[oó]n general/i.test(lower) && !specs.includes('Mecánica general')) specs.push('Mecánica general');

  const isRoleOnly = isOwner || isMechanic || isBoth || /\b(?:propi?e?r?t|dueñ|mecanic|mecánic|patron|patrón|socio)\b/i.test(lower);
  const isAddressString = addrMatch || /\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida)\b/i.test(raw);

  if (specs.length > 0) {
    updates.especialidad = specs;
  } else if (isProtest) {
    updates.especialidad = ['Mecánica general'];
  } else if (isSpecQuestion && !isRoleOnly && !isAddressString && !isProtest && (!sessionData.especialidad || sessionData.especialidad.length === 0)) {
    const cleanSpec = raw.replace(/(?:soy|propi?e?r?t[a-z]*|mecanic[a-z]*|mecánic[a-z]*|dueñ[a-z]*|y|,)+/gi, '').trim();
    if (cleanSpec.length > 3 && !/\d/.test(cleanSpec)) updates.especialidad = [cleanSpec];
  }

  // Motorcycle types (tipo_motos)
  const types = Array.isArray(sessionData.tipo_motos) ? [...sessionData.tipo_motos] : [];
  if (/scooter|automatica|automática/i.test(lower) && !types.includes('Scooter')) types.push('Scooter');
  if (/alto cilindraje|grande/i.test(lower) && !types.includes('Alto cilindraje')) types.push('Alto cilindraje');
  if (/bajo cilindraje/i.test(lower) && !types.includes('Bajo cilindraje')) types.push('Bajo cilindraje');
  if (/4\s*t/i.test(lower) && !types.includes('4T')) types.push('4T');
  if (/2\s*t/i.test(lower) && !types.includes('2T')) types.push('2T');
  if (types.length > 0) updates.tipo_motos = types;

  // Years of experience (experiencia_mecanico)
  const expMatch = raw.match(/\b(\d+)\s*(?:a[ñn]os?|meses)\b/i);
  if (expMatch && !sessionData.experiencia_mecanico) {
    updates.experiencia_mecanico = `${expMatch[1]} años`;
  }

  // 7. Volume (motos_por_semana)
  const isVolumeQuestion = sessionData._lastQuestion === 'VOLUMEN' || sessionData._lastQuestion === 'VOLUMEN_Y_MARCAS';
  if ((isVolumeQuestion || /muchas|bastantes|un monton|monton|harto|full|motos por semana|por semana/i.test(lower)) && !sessionData.motos_por_semana) {
    if (/mucha|bastante|harto|montón|monton|full/i.test(lower)) {
      updates.motos_por_semana = 'Alta afluencia (+30 motos/semana)';
    } else {
      const numMatch = lower.match(/\b\d+\b/);
      if (numMatch) updates.motos_por_semana = `${numMatch[0]} motos/semana`;
      else if (isVolumeQuestion) updates.motos_por_semana = raw;
    }
  }

  // 8. Motorcycle Brands (marcas_motos - ONLY when asked or explicit moto brand names!)
  const isMotoBrandQuestion = sessionData._lastQuestion === 'MARCAS_MOTOS' || sessionData._lastQuestion === 'VOLUMEN_Y_MARCAS';
  const brands = Array.isArray(sessionData.marcas_motos) ? [...sessionData.marcas_motos] : [];
  if (/yamaha/i.test(lower) && !brands.includes('Yamaha')) brands.push('Yamaha');
  if (/bajaj|pulsar|boxer|bjaja/i.test(lower) && !brands.includes('Bajaj')) brands.push('Bajaj');
  if (/akt|nkd/i.test(lower) && !brands.includes('AKT')) brands.push('AKT');
  if (/honda/i.test(lower) && !brands.includes('Honda')) brands.push('Honda');
  if (/suzuki/i.test(lower) && !brands.includes('Suzuki')) brands.push('Suzuki');
  if (/tvs/i.test(lower) && !brands.includes('TVS')) brands.push('TVS');
  if (/hero/i.test(lower) && !brands.includes('Hero')) brands.push('Hero');
  if (/ktm/i.test(lower) && !brands.includes('KTM')) brands.push('KTM');
  if (isMotoBrandQuestion && /todas|de todas|variadas|de todo/i.test(lower) && !brands.includes('Variadas / Todas')) {
    brands.push('Variadas / Todas');
  }
  if (brands.length > 0) updates.marcas_motos = brands;

  // 9. Frequent Parts & Parts Brands & Decision Maker
  const isPartsQuestion = sessionData._lastQuestion === 'REPUESTOS' || sessionData._lastQuestion === 'REPUESTOS_Y_MARCA';
  const hasPartsContext = isPartsQuestion || /(?:cambiamos|cambio|se cambia|repuesto|repuestos|instalamos|instalo|kit|pastilla|arrastre)/i.test(lower);
  if (hasPartsContext) {
    const parts = Array.isArray(sessionData.repuestos_frecuentes) ? [...sessionData.repuestos_frecuentes] : [];
    if (/freno|pastilla|banda|disco/i.test(lower) && !parts.includes('Frenos')) parts.push('Frenos');
    if (/arrastre|kit|cadena|piñon|pinon|corona/i.test(lower) && !parts.includes('Kit de arrastre')) parts.push('Kit de arrastre');
    if (/motor|valvula|válvula|cilindro|piston|pistón|anillos/i.test(lower) && !parts.includes('Partes de motor')) parts.push('Partes de motor');
    if (/aceite|filtro|lubricante/i.test(lower) && !parts.includes('Lubricación / Filtros')) parts.push('Lubricación / Filtros');
    if (/suspension|suspensión|amortiguador|retenedor|retenes|telescopica/i.test(lower) && !parts.includes('Suspensión')) parts.push('Suspensión');
    if (/electr|bateria|batería|inyeccion|inyección|bobina|bujia|bujía|bombillo/i.test(lower) && !parts.includes('Electricidad')) parts.push('Electricidad');
    if (/llanta|neumatico|neumático|rin|rines/i.test(lower) && !parts.includes('Llantas / Rines')) parts.push('Llantas / Rines');
    if (/guaya|cable|manecilla|comando/i.test(lower) && !parts.includes('Guayas y Mandos')) parts.push('Guayas y Mandos');
    if (/rodamiento|balinera|cuna/i.test(lower) && !parts.includes('Rodamientos')) parts.push('Rodamientos');
    if (/de todo|variado|varios|general|todo tipo|todas|todos|de todo un poco|lo que llegue|cualquiera/i.test(lower) && !parts.includes('Variados / De todo')) {
      parts.push('Variados / De todo');
    }

    if (parts.length > 0) {
      updates.repuestos_frecuentes = parts;
    } else if (isPartsQuestion && raw.trim().length >= 1) {
      updates.repuestos_frecuentes = ['Variados / De todo'];
    }
  }

  // Parts brands used/recommended
  const isPartBrandQuestion = sessionData._lastQuestion === 'MARCA_RECOMENDADA' || sessionData._lastQuestion === 'REPUESTOS_Y_MARCA';
  const partBrands = Array.isArray(sessionData.marcas_repuestos_usadas) ? [...sessionData.marcas_repuestos_usadas] : [];
  if (/nitrox/i.test(lower) && !partBrands.includes('NITROX')) partBrands.push('NITROX');
  if (/ichiban/i.test(lower) && !partBrands.includes('Ichiban')) partBrands.push('Ichiban');
  if (/revo/i.test(lower) && !partBrands.includes('Revo')) partBrands.push('Revo');
  if (/original|genuino/i.test(lower) && !partBrands.includes('Originales')) partBrands.push('Originales');
  if (/yamaha/i.test(lower) && isPartBrandQuestion && !partBrands.includes('Yamaha')) partBrands.push('Yamaha');
  if (/bajaj/i.test(lower) && isPartBrandQuestion && !partBrands.includes('Bajaj')) partBrands.push('Bajaj');
  if (/akt/i.test(lower) && isPartBrandQuestion && !partBrands.includes('AKT')) partBrands.push('AKT');
  if (/brembo/i.test(lower) && !partBrands.includes('Brembo')) partBrands.push('Brembo');
  if (isPartBrandQuestion && /todas|de todo|variadas|cualquiera|varias/i.test(lower) && !partBrands.includes('Variadas / De todo')) {
    partBrands.push('Variadas / De todo');
  }
  if (isPartBrandQuestion && /ninguna|no recomiendo/i.test(lower) && !partBrands.includes('Sin preferencia')) {
    partBrands.push('Sin preferencia');
  }
  if (isPartBrandQuestion && /cliente|ellos traen|el cliente/i.test(lower) && !partBrands.includes('La que traiga el cliente')) {
    partBrands.push('La que traiga el cliente');
  }

  if (partBrands.length > 0) {
    updates.marcas_repuestos_usadas = partBrands;
  } else if (isPartBrandQuestion && raw.trim().length >= 1) {
    if (isProtest) {
      updates.marcas_repuestos_usadas = ['Variadas / Originales'];
    } else {
      updates.marcas_repuestos_usadas = [raw.trim()];
    }
  }

  // Decision maker & Channel from recommendation context
  if (/yo le sujiero|yo le sugiero|yo recomiendo|yo decido|yo les digo|yo|el mecanico|el mecánico|nosotros/i.test(lower) && !sessionData.quien_decide_repuesto) {
    updates.quien_decide_repuesto = 'Mecánico';
    updates.frecuencia_recomendacion = 'Siempre';
  } else if (/cliente|dueno de la moto|dueño de la moto|ellos traen|propietarios de los veh[ií]culos|los clientes los traen|traen los repuestos|la que traiga/i.test(lower)) {
    updates.quien_decide_repuesto = 'Cliente';
    updates.frecuencia_recomendacion = 'Algunas veces';
    updates.canal_compra = 'Los clientes / propietarios los compran';
    if (!updates.marcas_repuestos_usadas && (!sessionData.marcas_repuestos_usadas || sessionData.marcas_repuestos_usadas.length === 0)) {
      updates.marcas_repuestos_usadas = ['La que traiga el cliente'];
    }
  } else if (isPartBrandQuestion && !sessionData.quien_decide_repuesto && !updates.quien_decide_repuesto) {
    updates.quien_decide_repuesto = 'Mecánico';
    updates.frecuencia_recomendacion = 'Frecuentemente';
  }

  // Why they recommend / Choice factors (factores_eleccion_repuesto)
  const factors = Array.isArray(sessionData.factores_eleccion_repuesto) ? [...sessionData.factores_eleccion_repuesto] : [];
  if (/calidad|buena calidad/i.test(lower) && !factors.includes('Calidad')) factors.push('Calidad');
  if (/duraci[oó]n|durabilidad|duran/i.test(lower) && !factors.includes('Durabilidad')) factors.push('Durabilidad');
  if (/garant[ií]a|respaldo/i.test(lower) && !factors.includes('Garantía-respaldo')) factors.push('Garantía-respaldo');
  if (/precio|econ[oó]mico|barato|margen/i.test(lower) && !factors.includes('Precio')) factors.push('Precio');
  if (/confianza|seguridad/i.test(lower) && !factors.includes('Confianza')) factors.push('Confianza');
  if (factors.length > 0) {
    updates.factores_eleccion_repuesto = factors;
    updates.criterio_compra = factors.join(', ');
  }

  // 10. Purchase Channel (where mechanic buys)
  const isChannelQuestion = sessionData._lastQuestion === 'CANAL_COMPRA';
  if (isChannelQuestion || /(?:distribuidor|directo de fabrica|almacen de repuestos|donde salga mas barato)/i.test(lower)) {
    if (/distrib/i.test(lower)) updates.canal_compra = 'Distribuidor';
    else if (/direct/i.test(lower)) updates.canal_compra = 'Directo';
    else if (/almacen|almacenes|repuestera/i.test(lower)) updates.canal_compra = 'Almacén de repuestos';
    else if (/barato|economico|económico|precio/i.test(lower)) updates.canal_compra = 'Donde salga más barato';
    else if (isChannelQuestion) updates.canal_compra = raw;
  }

  // 11. NITROX Experience & Interest (Strictly real data!)
  if (sessionData._lastQuestion === 'NITROX_EXP_INTERES' || sessionData._lastQuestion === 'OFERTA_MUESTRAS' || /repuestos nitrox|marca nitrox/i.test(lower)) {
    if (/no\b|nunca|todavia no|todavía no|no la conozco|no lo conozco|no los conozco|no he trabajado|no la conoco/i.test(lower)) {
      updates.conoce_nitrox = 'No';
      updates.ha_usado_nitrox = 'No';
      updates.calificacion_experiencia_nitrox = 'No aplica';
      updates.recomendaria_nitrox = 'No aplica';
    } else if (/si\b|sí\b|claro|bueno|buenos|excelente|salido buenos|los he usado/i.test(lower)) {
      updates.conoce_nitrox = 'Sí';
      updates.ha_usado_nitrox = 'Sí';
      updates.calificacion_experiencia_nitrox = /excelente/i.test(lower) ? 'Excelente' : 'Buena';
      updates.recomendaria_nitrox = 'Definitivamente sí';
    }

    // Samples / Capacitaciones interest
    if (/muestras|capacitaci[oó]n|capacitaciones|cat[aá]logo|interes|interesa|me gustar[ií]a|de una/i.test(lower)) {
      updates.quiere_muestras = 'Sí';
      const acts = [];
      if (/muestra/i.test(lower) || !sessionData.actividades_interes) acts.push('Muestras de repuestos');
      if (/capacita/i.test(lower)) acts.push('Capacitaciones técnicas');
      if (/cat[aá]logo/i.test(lower)) acts.push('Catálogo físico/digital');
      updates.actividades_interes = acts.length > 0 ? acts : ['Muestras de repuestos', 'Capacitaciones técnicas'];
    }
  }

  // 12. Benefits Contact Info (Email, Cedula, NIT)
  const isBenefitsQuestion = sessionData._lastQuestion === 'BENEFICIOS_DATOS';
  const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    updates.correo = emailMatch[0].toLowerCase();
  }

  const idMatch = raw.match(/(?:nit|cedula|c\.c\.|cc)?\s*(\b\d{7,10}(?:-\d)?\b)/i);
  if (idMatch && (!updates.correo || !idMatch[1].includes('@'))) {
    updates.cedula = idMatch[1];
  }

  if (isBenefitsQuestion) {
    sessionData._datosBeneficiosSolicitados = true;
    if (/no tengo|no gracias|despu[eé]s|solo whatsapp|ninguno|no me gustar[ií]a|no uso correo/i.test(lower)) {
      if (!updates.correo && !sessionData.correo) updates.correo = 'No especificado';
      if (!updates.cedula && !sessionData.cedula) updates.cedula = 'No especificada';
    }
  }

  // 13. Habeas Data / Legal Data Treatment Acceptance
  if (sessionData._lastQuestion === 'HABEAS_DATA') {
    updates._habeasDataRespondido = true;
    if (/(?:no\s*gracias|no\s*acepto|no\s*autorizo|^no\b|para nada|negativo)/i.test(lower)) {
      updates.autorizacion_tratamiento_datos = false;
      updates.autorizacion_comunicaciones_comerciales = false;
      updates.acepta_registro = false;
    } else {
      // Affirmative: "si", "sí", "acepto", "autorizo", "claro", "de una", "ok", "listo", "dale", etc.
      updates.autorizacion_tratamiento_datos = true;
      updates.autorizacion_comunicaciones_comerciales = true;
      updates.acepta_registro = true;
    }
  }

  return updates;
}

// Persistent session management via Firestore + RAM cache
async function getSession(phoneNumber) {
  try {
    const doc = await admin.firestore().collection('sesiones_mateo').doc(phoneNumber).get();
    if (doc.exists) {
      const fsData = doc.data();
      const local = memoryCache[phoneNumber];
      // Si Firestore tiene historial igual o más largo, o no hay local, tomamos Firestore
      if (!local || (fsData.history && fsData.history.length >= (local.history?.length || 0))) {
        memoryCache[phoneNumber] = fsData;
        return fsData;
      }
      return local;
    }
  } catch (e) {
    // Si no hay Firestore o falla credencial (ej. local), fallback a memoria
  }

  if (memoryCache[phoneNumber]) {
    return memoryCache[phoneNumber];
  }

  const newSession = {
    data: {},
    history: []
  };
  memoryCache[phoneNumber] = newSession;
  return newSession;
}

async function saveSession(phoneNumber, session) {
  memoryCache[phoneNumber] = session;
  try {
    await admin.firestore().collection('sesiones_mateo').doc(phoneNumber).set(session, { merge: true });
  } catch (e) {
    console.warn('[FIRESTORE SAVE SESSION]', e.message);
  }
}

// Global in-memory cache for mechanics fallback
const localMecanicosStore = [];

async function saveMechanicToFirestore(phone, data) {
  const cleanPhone = (phone || '').replace(/\D/g, '');
  if (!data.id_unico) {
    const rawId = (cleanPhone.slice(-4) || 'RN') + Math.random().toString(36).substring(2, 6).toUpperCase();
    data.id_unico = `RN-MED-${rawId}`;
  }

  const normalized = normalizeMechanicData({
    ...data,
    celular_whatsapp: cleanPhone,
    telefono: cleanPhone,
    tiene_whatsapp: true,
    promotor: 'Agente WhatsApp Mateo (Canal Principal)',
    origen_registro: 'WhatsApp'
  }, 'WhatsApp');

  const existingIdx = localMecanicosStore.findIndex(m => m.id_unico === normalized.id_unico || (cleanPhone && m.celular_whatsapp === cleanPhone));
  if (existingIdx >= 0) {
    localMecanicosStore[existingIdx] = Object.assign(localMecanicosStore[existingIdx], normalized);
  } else {
    localMecanicosStore.unshift(normalized);
  }

  try {
    await admin.firestore().collection('mecanicos_red_nitrox').doc(normalized.id_unico).set(normalized, { merge: true });
  } catch (err) {
    console.warn('[FIRESTORE MECHANIC SAVE (fallback local)]', err.message);
  }
  return normalized;
}

// Core Conversational Brain: 100% of user messages are processed by Gemini first
async function generateMateoResponse(fromNumber, userText) {
  const session = await getSession(fromNumber);
  session.history = session.history || [];
  session.data = session.data || {};

  const raw = (userText || '').trim();
  const lower = raw.toLowerCase();

  // Reset session if user explicitly requests to start over
  if (/(?:otro taller|nuevo taller|registrar otro|reiniciar|borrar datos)/i.test(lower)) {
    session.data = {};
    session.history = [];
  }

  // 1. Send turn to Gemini Conversational Brain (Gemini analyzes context, user intent, history & generates the natural reply)
  const brainResult = await getProcessGeminiBrainTurn()(session, raw);

  // 2. Merge extracted semantic data from Gemini Brain
  if (brainResult.updates && typeof brainResult.updates === 'object') {
    for (const [key, val] of Object.entries(brainResult.updates)) {
      if (val !== null && val !== undefined && val !== '') {
        if (Array.isArray(val) && val.length === 0) continue;
        session.data[key] = val;
      }
    }
  }

  // 3. Fallback deterministic regex extraction for high-precision entities (email, cedula/nit, phone)
  const regexEntities = extractEntities(raw, session.data);
  for (const [key, val] of Object.entries(regexEntities)) {
    if (val !== null && val !== undefined && val !== '' && !session.data[key]) {
      session.data[key] = val;
    }
  }

  // Clean formatting for workshop and personal names
  if (session.data.nombre_taller) {
    session.data.nombre_taller = cleanWorkshopName(session.data.nombre_taller);
  }
  if (session.data.nombres_apellidos) {
    session.data.nombres_apellidos = cleanPersonName(session.data.nombres_apellidos) || session.data.nombres_apellidos;
  }

  // Check Habeas Data resolution
  if (session.data.autorizacion_tratamiento_datos !== undefined && session.data.autorizacion_tratamiento_datos !== null) {
    session.data._habeasDataRespondido = true;
  }

  // Progressive sync with Firestore / CRM
  if (session.data.nombres_apellidos || session.data.nombre_taller) {
    await saveMechanicToFirestore(fromNumber, session.data);
  }

  // Token usage tracking and economics calculation
  session.tokenStats = session.tokenStats || {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalCostCop: 0,
    turnsCount: 0
  };

  if (brainResult.tokenUsage) {
    const tu = brainResult.tokenUsage;
    session.tokenStats.totalInputTokens += (tu.inputTokens || 0);
    session.tokenStats.totalOutputTokens += (tu.outputTokens || 0);
    session.tokenStats.totalTokens += (tu.totalTokens || 0);
    session.tokenStats.totalCostUsd = Number((session.tokenStats.totalCostUsd + (tu.costUsd || 0)).toFixed(7));
    session.tokenStats.totalCostCop = Number((session.tokenStats.totalCostCop + (tu.costCop || 0)).toFixed(4));
    session.tokenStats.turnsCount += 1;
    session.tokenStats.lastUpdated = new Date().toISOString();
  }

  // 4. Update session history with token metrics
  session.history.push({ role: 'user', content: raw, timestamp: Date.now() });
  session.history.push({
    role: 'assistant',
    content: brainResult.reply,
    timestamp: Date.now(),
    tokens: brainResult.tokenUsage
  });

  // 5. Final Delivery Check (QR Credential & Digital Carnet)
  const isFinished = Boolean(brainResult.isFinished || (session.data._habeasDataRespondido && session.data.nombre_taller));

  if (isFinished && !session.data._finished) {
    session.data._finished = true;
    const mechanic = await saveMechanicToFirestore(fromNumber, session.data);
    await saveSession(fromNumber, session);
    triggerMlAnalysis(fromNumber, session);

    // If mechanic declined Habeas Data
    if (session.data.autorizacion_tratamiento_datos === false) {
      return [brainResult.reply];
    }

    // Mechanic accepted Habeas Data -> Deliver QR card image + digital carnet link
    const cleanPhone = (fromNumber || '').replace(/\D/g, '');
    const uniqueId = mechanic.id_unico || session.data.id_unico || (`RN-MED-${(cleanPhone.slice(-4) || 'RN') + Math.random().toString(36).substring(2, 6).toUpperCase()}`);
    const baseUrl = 'https://webhook-my2e3j2ecq-uc.a.run.app';
    const cardUrl = `${baseUrl}/carnet/${encodeURIComponent(uniqueId)}`;
    const cardImageUrl = `${baseUrl}/api/card-image/${encodeURIComponent(uniqueId)}.png`;
    const workshopLabel = session.data.nombre_taller || 'tu taller';

    const qrBubble = {
      type: 'image',
      url: cardImageUrl,
      caption: `Credencial Oficial y Código QR RED NITROX • ${workshopLabel}`
    };
    const bubble2 = `🏁 *¡Ya haces parte de la RED NITROX!*\n\nAquí tienes tu enlace y credencial digital oficial de ${workshopLabel}:\n👉 ${cardUrl}\n\n¡Bienvenido a la red de talleres aliados!`;

    return [brainResult.reply, qrBubble, bubble2];
  }

  // Normal turn or post-registration follow up
  await saveSession(fromNumber, session);

  return [brainResult.reply];
}

async function getAllSessions() {
  const sessionsMap = new Map();

  // 1. Cargar caché de memoria primero
  for (const [phone, sess] of Object.entries(memoryCache)) {
    sessionsMap.set(phone, { phone, ...sess });
  }

  // 2. Sobreponer datos de Firestore (fuente de verdad oficial)
  try {
    const snap = await admin.firestore().collection('sesiones_mateo').limit(100).get();
    snap.forEach(doc => {
      const phone = doc.id;
      const fsData = doc.data();
      const existing = sessionsMap.get(phone);
      if (!existing || (fsData.history && fsData.history.length >= (existing.history?.length || 0))) {
        sessionsMap.set(phone, { phone, ...fsData });
        memoryCache[phone] = fsData;
      }
    });
  } catch (e) {
    // Ignore fallback en local
  }

  return Array.from(sessionsMap.values());
}

function resetMemoryCache() {
  for (const k in memoryCache) {
    delete memoryCache[k];
  }
}

module.exports = {
  generateMateoResponse,
  admin,
  localMecanicosStore,
  getAllSessions,
  saveSession,
  memoryCache,
  resetMemoryCache
};