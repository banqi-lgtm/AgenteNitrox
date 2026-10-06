const admin = require('firebase-admin');
const { normalizeMechanicData, calculateMechanicScore, calculateNitroxLevel } = require('./scoring');

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
  s = s.replace(/^(?:hola|buenas|buenos dias|buenas tardes|soy|me llamo|mi nombre es)\s+/gi, '');
  s = s.replace(/(?:taller|motos|repuestos).*$/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (isPureGreeting(s) || isGreetingResponse(s)) return '';
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 1 && /^(hola|buenas|quiero|taller|motos|info)$/i.test(words[0])) return '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Helper to extract and clean workshop name
function cleanWorkshopName(str) {
  if (!str) return '';
  let s = str.replace(/^(?:y mi taller es|mi taller se llama|el taller es|el taller se llama|el taller|taller:\s*)\s*/gi, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  if (!/taller|motos|garage|repuestos/i.test(s)) {
    s = 'Taller ' + s;
  }
  return s.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Helper to parse Name & Workshop if provided together or separately
function parseNameAndWorkshop(raw) {
  let name = '';
  let workshop = '';
  const clean = (raw || '').trim();

  if (isGreeting(clean)) return { name: '', workshop: '' };

  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const isW0 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(lines[0]);
    const isW1 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(lines[1]);
    if (isW1 && !isW0) {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
    } else if (isW0 && !isW1) {
      workshop = cleanWorkshopName(lines[0]);
      name = cleanPersonName(lines[1]);
    } else {
      name = cleanPersonName(lines[0]);
      workshop = cleanWorkshopName(lines[1]);
    }
    return { name, workshop };
  }

  if (clean.includes(',') || /\s+y\s+/i.test(clean)) {
    const parts = clean.split(/,|\s+y\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const isW0 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(parts[0]);
      const isW1 = /(?:taller|motos|moto|repuestos|racing|servi|garage|motor)/i.test(parts[1]);
      if (isW1 && !isW0) {
        name = cleanPersonName(parts[0]);
        workshop = cleanWorkshopName(parts[1]);
      } else if (isW0 && !isW1) {
        workshop = cleanWorkshopName(parts[0]);
        name = cleanPersonName(parts[1]);
      }
      return { name, workshop };
    }
  }

  const deMatch = clean.match(/(?:soy|me llamo|mi nombre es)?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:de|del|y mi taller es|y el taller es)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+)/i);
  if (deMatch && deMatch[1].trim() && deMatch[2].trim()) {
    name = cleanPersonName(deMatch[1]);
    workshop = cleanWorkshopName(deMatch[2]);
    return { name, workshop };
  }

  if (/^(?:taller|el taller|moto taller|motos|repuestos|garage)\s+[A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]+$/i.test(clean) || (/(?:taller|repuestos|garage)/i.test(clean) && clean.split(/\s+/).length <= 4)) {
    workshop = cleanWorkshopName(clean);
    return { name: '', workshop };
  }

  if (!isGreeting(clean) && clean.split(/\s+/).length <= 4 && !/(?:bello|itagui|medellin|mecanico|dueño|motos|akt|repuestos)/i.test(clean)) {
    name = cleanPersonName(clean);
    return { name, workshop: '' };
  }

  return { name: '', workshop: '' };
}

// Semantic entity extractor for real-world messages, typos and Colombian mechanic slang
function extractEntities(text, sessionData) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();
  const updates = {};

  // 1. Name & Workshop if missing
  if (!sessionData.nombres_apellidos || !sessionData.nombre_taller) {
    if (sessionData._lastQuestion === 'NOMBRE' && !sessionData.nombres_apellidos) {
      const p = cleanPersonName(raw);
      if (p) updates.nombres_apellidos = p;
    } else if (sessionData._lastQuestion === 'TALLER' && !sessionData.nombre_taller) {
      const w = cleanWorkshopName(raw);
      if (w) updates.nombre_taller = w;
    } else {
      const { name, workshop } = parseNameAndWorkshop(raw);
      if (name && !sessionData.nombres_apellidos) updates.nombres_apellidos = name;
      if (workshop && !sessionData.nombre_taller) updates.nombre_taller = workshop;
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

  // 3. Dirección (Address)
  const addrMatch = raw.match(/\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|cra\.|cll\.)\b\s+[0-9a-zA-Z#\s\-\.\°]+/i)
    || raw.match(/\b\d+\s*#\s*\d+[\s\-0-9a-zA-Z]*/i);
  if (addrMatch) {
    updates.direccion_taller = addrMatch[0].trim();
  } else if (sessionData._lastQuestion === 'DIRECCION' && !sessionData.direccion_taller) {
    if (/\d/.test(raw) || /\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida|esquina|con|frente|cerca)\b/i.test(lower)) {
      updates.direccion_taller = raw;
    }
  }

  // 4. Barrio
  const barrioMatch = raw.match(/(?:en\s+|barrio\s+)?\b(bel[eé]n|laureles|guayabal|robledo|castilla|aranjuez|manrique|prado|san javier|buenos aires|centro|la am[eé]rica|poblado|floresta|estadio|calasanz|santa cruz|popular|villa hermosa|san crist[oó]bal|san antonio de prado|niqu[ií]a|caba[ñn]as|boston|ditaires|santa mar[ií]a|sim[oó]n bol[ií]var|la castellana)\b/i);
  if (barrioMatch) {
    const b = barrioMatch[1];
    updates.barrio_taller = b.charAt(0).toUpperCase() + b.slice(1).toLowerCase();
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

  // 5. Role (Relación con el taller)
  if (/ambas|las dos|ambos|dueño y mecanico|propietario y mecanico|propietario y mecánico/i.test(lower)) {
    updates.relacion_taller = 'Propietario y Mecánico';
  } else if (/mecanico|mecánico|empleado|las arreglo yo|yo arreglo|trabajador/i.test(lower)) {
    updates.relacion_taller = 'Mecánico';
  } else if (/dueño|dueno|propietario|el taller es mio|es mio|yo lo manejo|patron|patrón/i.test(lower)) {
    updates.relacion_taller = 'Propietario';
  } else if (/socio|copropietario/i.test(lower)) {
    updates.relacion_taller = 'Socio';
  }

  // 6. Professional Specialty (Perfil Profesional y Especialidad)
  const isSpecQuestion = sessionData._lastQuestion === 'ROL_ESPECIALIDAD';
  const specs = Array.isArray(sessionData.especialidad) ? [...sessionData.especialidad] : [];
  if (/motor|motores|ajuste|anillado|culata/i.test(lower) && !specs.includes('Motor / 4T')) specs.push('Motor / 4T');
  if (/2\s*t|2\s*tiempos/i.test(lower) && !specs.includes('2T')) specs.push('2T');
  if (/4\s*t|4\s*tiempos/i.test(lower) && !specs.includes('4T') && !specs.includes('Motor / 4T')) specs.push('4T');
  if (/freno|frenos|pastilla|banda|disco|suspensi[oó]n|amortiguador/i.test(lower) && !specs.includes('Frenos / Suspensión')) specs.push('Frenos / Suspensión');
  if (/electricidad|el[eé]ctrico|electrico|inyecci[oó]n|inyeccion|electr[oó]nica|bobina|bater[ií]a/i.test(lower) && !specs.includes('Electricidad / Inyección electrónica')) specs.push('Electricidad / Inyección electrónica');
  if (/general|de todo|todas|mec[aá]nica general|reparaci[oó]n general/i.test(lower) && !specs.includes('Mecánica general')) specs.push('Mecánica general');

  const isAddressString = addrMatch || /\b(?:calle|cll|carrera|cra|diagonal|diag|transversal|transv|circular|circ|av|avenida)\b/i.test(raw);

  if (specs.length > 0) {
    updates.especialidad = specs;
  } else if (isSpecQuestion && !isAddressString && (!sessionData.especialidad || sessionData.especialidad.length === 0)) {
    const cleanSpec = raw.replace(/(?:soy|propietario|mecanico|mecánico|dueño|y|,)+/gi, '').trim();
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
  const isVolumeQuestion = sessionData._lastQuestion === 'VOLUMEN_MARCAS';
  if ((isVolumeQuestion || /muchas|bastantes|un monton|monton|harto|full|motos por semana|por semana/i.test(lower)) && !sessionData.motos_por_semana) {
    if (/mucha|bastante|harto|montón|monton|full/i.test(lower)) {
      updates.motos_por_semana = 'Alta afluencia (+30 motos/semana)';
    } else {
      const numMatch = lower.match(/\b\d+\b/);
      if (numMatch) updates.motos_por_semana = `${numMatch[0]} motos/semana`;
      else if (isVolumeQuestion) updates.motos_por_semana = raw;
    }
  }

  // 8. Motorcycle Brands (marcas_motos)
  const brands = Array.isArray(sessionData.marcas_motos) ? [...sessionData.marcas_motos] : [];
  if (/yamaha/i.test(lower) && !brands.includes('Yamaha')) brands.push('Yamaha');
  if (/bajaj|pulsar|boxer|bjaja/i.test(lower) && !brands.includes('Bajaj')) brands.push('Bajaj');
  if (/akt|nkd/i.test(lower) && !brands.includes('AKT')) brands.push('AKT');
  if (/honda/i.test(lower) && !brands.includes('Honda')) brands.push('Honda');
  if (/suzuki/i.test(lower) && !brands.includes('Suzuki')) brands.push('Suzuki');
  if (/tvs/i.test(lower) && !brands.includes('TVS')) brands.push('TVS');
  if (/hero/i.test(lower) && !brands.includes('Hero')) brands.push('Hero');
  if (/ktm/i.test(lower) && !brands.includes('KTM')) brands.push('KTM');
  if (/todas|de todas|variadas|de todo/i.test(lower) && !brands.includes('Variadas / Todas')) brands.push('Variadas / Todas');
  if (brands.length > 0) updates.marcas_motos = brands;

  // 9. Frequent Parts & Parts Brands & Decision Maker
  const isPartsQuestion = sessionData._lastQuestion === 'REPUESTOS_Y_MARCA';
  const hasPartsContext = isPartsQuestion || /(?:cambiamos|cambio|se cambia|repuesto|repuestos|instalamos|instalo|kit|pastilla)/i.test(lower);
  if (hasPartsContext) {
    const parts = Array.isArray(sessionData.repuestos_frecuentes) ? [...sessionData.repuestos_frecuentes] : [];
    if (/freno|pastilla|banda|disco/i.test(lower) && !parts.includes('Frenos')) parts.push('Frenos');
    if (/arrastre|kit|cadena|piñon|pinon|corona/i.test(lower) && !parts.includes('Kit de arrastre')) parts.push('Kit de arrastre');
    if (/motor|valvula|válvula|cilindro|piston|pistón|anillos/i.test(lower) && !parts.includes('Partes de motor')) parts.push('Partes de motor');
    if (/aceite|filtro|lubricante/i.test(lower) && !parts.includes('Lubricación / Filtros')) parts.push('Lubricación / Filtros');
    if (/suspension|suspensión|amortiguador|retenedor/i.test(lower) && !parts.includes('Suspensión')) parts.push('Suspensión');
    if (/electr|bateria|batería|inyeccion|inyección/i.test(lower) && !parts.includes('Electricidad')) parts.push('Electricidad');
    if (parts.length > 0) updates.repuestos_frecuentes = parts;
  }

  // Parts brands used/recommended
  const partBrands = Array.isArray(sessionData.marcas_repuestos_usadas) ? [...sessionData.marcas_repuestos_usadas] : [];
  if (/nitrox/i.test(lower) && !partBrands.includes('NITROX')) partBrands.push('NITROX');
  if (/ichiban/i.test(lower) && !partBrands.includes('Ichiban')) partBrands.push('Ichiban');
  if (/revo/i.test(lower) && !partBrands.includes('Revo')) partBrands.push('Revo');
  if (/original|genuino/i.test(lower) && !partBrands.includes('Originales')) partBrands.push('Originales');
  if (/yamaha/i.test(lower) && isPartsQuestion && !partBrands.includes('Yamaha')) partBrands.push('Yamaha');
  if (/bajaj/i.test(lower) && isPartsQuestion && !partBrands.includes('Bajaj')) partBrands.push('Bajaj');
  if (/akt/i.test(lower) && isPartsQuestion && !partBrands.includes('AKT')) partBrands.push('AKT');
  if (/brembo/i.test(lower) && !partBrands.includes('Brembo')) partBrands.push('Brembo');
  if (partBrands.length > 0) updates.marcas_repuestos_usadas = partBrands;

  // Decision maker & Channel from recommendation context
  if (/yo le sujiero|yo le sugiero|yo recomiendo|yo decido|yo les digo|yo|el mecanico|el mecánico/i.test(lower) && !sessionData.quien_decide_repuesto) {
    updates.quien_decide_repuesto = 'Mecánico';
    updates.frecuencia_recomendacion = 'Siempre';
  } else if (/cliente|dueno de la moto|dueño de la moto|ellos traen|propietarios de los veh[ií]culos|los clientes los traen|traen los repuestos/i.test(lower)) {
    updates.quien_decide_repuesto = 'Cliente';
    updates.frecuencia_recomendacion = 'Algunas veces';
    updates.canal_compra = 'Los clientes / propietarios los compran';
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
  if (sessionData._lastQuestion === 'NITROX_EXP_INTERES' || /repuestos nitrox|marca nitrox/i.test(lower)) {
    if (/no\b|nunca|todavia no|todavía no|no los conozco|no he trabajado/i.test(lower)) {
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
    updates.autorizacion_tratamiento_datos = true;
    updates.autorizacion_comunicaciones_comerciales = true;
    updates.acepta_registro = true;
  }

  const idMatch = raw.match(/(?:nit|cedula|c\.c\.|cc)?\s*(\b\d{7,10}(?:-\d)?\b)/i);
  if (idMatch && (!updates.correo || !idMatch[1].includes('@'))) {
    updates.cedula = idMatch[1];
    updates.autorizacion_tratamiento_datos = true;
    updates.autorizacion_comunicaciones_comerciales = true;
    updates.acepta_registro = true;
  }

  if (isBenefitsQuestion) {
    sessionData._datosBeneficiosSolicitados = true;
    if (/no tengo|no gracias|despu[eé]s|solo whatsapp|ninguno|no me gustar[ií]a/i.test(lower)) {
      if (!updates.correo && !sessionData.correo) updates.correo = 'No especificado';
      if (!updates.cedula && !sessionData.cedula) updates.cedula = 'No especificada';
      updates.autorizacion_tratamiento_datos = true;
      updates.autorizacion_comunicaciones_comerciales = true;
      updates.acepta_registro = true;
    }
  }

  return updates;
}

// Persistent session management via Firestore + RAM cache
async function getSession(phoneNumber) {
  if (memoryCache[phoneNumber]) {
    return memoryCache[phoneNumber];
  }

  try {
    const doc = await admin.firestore().collection('sesiones_mateo').doc(phoneNumber).get();
    if (doc.exists) {
      memoryCache[phoneNumber] = doc.data();
      return memoryCache[phoneNumber];
    }
  } catch (e) {
    console.warn('[FIRESTORE GET SESSION]', e.message);
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

// Core Prompt Maestro conversational response generator
async function generateMateoResponse(fromNumber, userText) {
  const session = await getSession(fromNumber);
  session.history = session.history || [];
  session.data = session.data || {};
  session.history.push({ role: 'user', content: userText, timestamp: Date.now() });

  const data = session.data;
  const raw = userText.trim();
  const lower = raw.toLowerCase();

  // Reset if user requests
  if (/(otro taller|nuevo taller|registrar otro|reiniciar|borrar datos)/i.test(lower)) {
    session.data = {};
    session.history = [];
    await saveSession(fromNumber, session);
    const reply = "¡Listo! Empecemos de nuevo. ¿Cómo te llamas y cómo se llama tu taller?";
    return [reply];
  }

  // 1. Pure greeting check: if user sends only a greeting first (Requirement: primero saludar, esperar que salude)
  if (!data._initialGreetingSent && isPureGreeting(raw)) {
    data._initialGreetingSent = true;
    data._lastQuestion = 'WAITING_GREETING_REPLY';
    const reply = "¡Hola! ¿Cómo estás? Soy Mateo, asesor de la RED NITROX en Medellín.";
    session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    await saveSession(fromNumber, session);
    return [reply];
  }

  // 2. Extract newly provided entities
  const newEntities = extractEntities(userText, data);
  Object.assign(data, newEntities);

  // If user was answering the initial greeting:
  if (data._lastQuestion === 'WAITING_GREETING_REPLY') {
    delete data._lastQuestion;
    if (!data.nombres_apellidos && !data.nombre_taller) {
      data._lastQuestion = 'NOMBRE_Y_TALLER';
      const reply = "Me alegra. ¿Cómo te llamas y cómo se llama tu taller de motos?";
      session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      await saveSession(fromNumber, session);
      return [reply];
    }
  }

  // 3. Synchronize progressively to Firestore / CRM
  if (data.nombres_apellidos || data.nombre_taller) {
    await saveMechanicToFirestore(fromNumber, data);
  }

  const firstName = (data.nombres_apellidos || '').split(' ')[0] || '';
  const workshopName = data.nombre_taller || '';

  // 4. User inquiry interceptor (if user asks what RED NITROX is)
  if (/(que es red nitrox|de que se trata|para que es|que beneficios|quien es nitrox)/i.test(lower)) {
    let reply = "Es una red de talleres aliados de NITROX en Medellín con capacitaciones, muestras de repuestos y beneficios directos.";
    if (!data.nombres_apellidos || !data.nombre_taller) {
      reply += " ¿Cómo te llamas y cómo se llama tu taller?";
      data._lastQuestion = 'NOMBRE_Y_TALLER';
    }
    session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    await saveSession(fromNumber, session);
    return [reply];
  }

  // 5. Decide the SINGLE logical next response based on memory and context
  let reply = '';

  // Turn: Name & Workshop
  if (!data.nombres_apellidos && !data.nombre_taller) {
    data._lastQuestion = 'NOMBRE_Y_TALLER';
    reply = "¡Hola! Soy Mateo, asesor de la RED NITROX. ¿Cómo te llamas y cómo se llama tu taller?";
  } else if (data.nombres_apellidos && !data.nombre_taller) {
    data._lastQuestion = 'TALLER';
    reply = `Mucho gusto, ${firstName}. ¿Cómo se llama tu taller?`;
  } else if (!data.nombres_apellidos && data.nombre_taller) {
    data._lastQuestion = 'NOMBRE';
    reply = `Excelente taller ${workshopName}. ¿Y cuál es tu nombre?`;
  }
  // Turn: Location (Barrio & Address obligatory!)
  else if (!data._askedUbicacion && (!data.barrio_taller || !data.direccion_taller)) {
    if (!data.barrio_taller && !data.direccion_taller) {
      data._lastQuestion = 'UBICACION';
      reply = `Mucho gusto, ${firstName}. ¿En qué barrio y en qué dirección queda tu taller?`;
    } else if (data.barrio_taller && !data.direccion_taller) {
      data._lastQuestion = 'DIRECCION';
      reply = `Listo en ${data.barrio_taller}. ¿Y cuál es la dirección exacta del taller?`;
    } else if (!data.barrio_taller && data.direccion_taller) {
      data._lastQuestion = 'BARRIO';
      reply = `Anotada la dirección. ¿Y en qué barrio o municipio queda?`;
    }
  }
  // Turn: Role & Specialty (Perfil Profesional)
  else if (!data._askedRolEspecialidad && (!data.relacion_taller || !data.especialidad || data.especialidad.length === 0)) {
    data._askedRolEspecialidad = true;
    data._lastQuestion = 'ROL_ESPECIALIDAD';
    reply = `Anotado. ¿Eres propietario o mecánico, y cuál es tu especialidad en el taller?`;
  }
  // Turn: Volume & Moto Brands
  else if (!data._askedVolumenMarcas && (!data.motos_por_semana || !data.marcas_motos || data.marcas_motos.length === 0)) {
    data._askedVolumenMarcas = true;
    data._lastQuestion = 'VOLUMEN_MARCAS';
    reply = `Perfecto. ¿Más o menos cuántas motos atiendes por semana y qué marcas te llegan más?`;
  }
  // Turn: Frequent Parts & Recommendation / Brands
  else if (!data._askedRepuestos) {
    data._askedRepuestos = true;
    data._lastQuestion = 'REPUESTOS_Y_MARCA';
    reply = `Buen flujo. ¿Qué repuestos cambias más seguido y qué marca sueles recomendar y por qué?`;
  }
  // Turn: NITROX Experience & Interest
  else if (!data._askedNitrox && !data.conoce_nitrox) {
    data._askedNitrox = true;
    data._lastQuestion = 'NITROX_EXP_INTERES';
    reply = `Buen dato. ¿Has trabajado antes con repuestos NITROX, o te interesaría recibir muestras y capacitaciones para el taller?`;
  }
  // Turn: Purchase Channel (if knows Nitrox and channel missing)
  else if (data.conoce_nitrox === 'Sí' && !data._askedCanal && !data.canal_compra) {
    data._askedCanal = true;
    data._lastQuestion = 'CANAL_COMPRA';
    reply = `Excelente. ¿Y dónde compras los repuestos normalmente?`;
  }
  // Turn: Pre-QR Benefits Contact Info (Correo, Cédula o NIT)
  else if (!data._datosBeneficiosSolicitados && !data.correo && !data.cedula) {
    data._datosBeneficiosSolicitados = true;
    data._lastQuestion = 'BENEFICIOS_DATOS';
    reply = `¡De una! Para enviarte los beneficios oficiales y activar tu vinculación, ¿me regalas tu Correo y tu Cédula o NIT?`;
  }
  // Turn: Final QR Delivery
  else if (!data._finished) {
    data._finished = true;
    const mechanic = await saveMechanicToFirestore(fromNumber, data);
    const uniqueId = mechanic.id_unico || data.id_unico || (`RN-MED-${Math.random().toString(36).substring(2, 6).toUpperCase()}`);
    const baseUrl = 'https://webhook-my2e3j2ecq-uc.a.run.app';
    const cardUrl = `${baseUrl}/carnet/${encodeURIComponent(uniqueId)}`;
    const cardImageUrl = `${baseUrl}/api/card-image/${encodeURIComponent(uniqueId)}.png`;

    const nameLabel = firstName || 'amigo';
    const workshopLabel = workshopName || 'tu taller';

    const sampleNote = data.quiere_muestras === 'Sí'
      ? 'Te tendremos súper en cuenta para hacerte llegar las muestras y el catálogo.'
      : 'Quedo súper atento por acá para lo que necesites.';

    const bubble1 = `Listo ${nameLabel}, anotado todo. ${sampleNote} Muy bacano ${workshopLabel}.`;
    const qrBubble = {
      type: 'image',
      url: cardImageUrl,
      caption: `Credencial Oficial y Código QR RED NITROX • ${workshopLabel}`
    };
    const bubble2 = `🏁 *¡Ya haces parte de la RED NITROX!*\n\nAquí tienes tu enlace y credencial digital oficial de ${workshopLabel}:\n👉 ${cardUrl}\n\n¡Bienvenido a la red de talleres aliados!`;

    session.history.push({ role: 'assistant', content: `${bubble1}\n${bubble2}`, timestamp: Date.now() });
    await saveSession(fromNumber, session);

    return [bubble1, qrBubble, bubble2];
  } else {
    const uniqueId = data.id_unico || '';
    const linkSuffix = uniqueId ? `\n👉 https://webhook-my2e3j2ecq-uc.a.run.app/carnet/${encodeURIComponent(uniqueId)}` : '';
    reply = `¡Con todo el gusto ${firstName || ''}! Por acá a la orden siempre.${linkSuffix}`;
  }

  // Word count checklist enforcement
  const wc = countWords(reply);
  if (wc > 25) {
    console.warn(`[WARNING: REPLY OVER 25 WORDS (${wc})]:`, reply);
  }

  session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
  await saveSession(fromNumber, session);

  // Return single clean, natural WhatsApp bubble
  return [reply];
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
  resetMemoryCache
};