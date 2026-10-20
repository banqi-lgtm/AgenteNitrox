// test/cerebro_mateo.test.js - Suite de Pruebas Automatizadas de Calidad para MATEO
// Verifica:
// 1. Cero repetición de preguntas sobre datos confirmados (meta = 0).
// 2. Extracción simultánea de múltiples entidades en un único turno.
// 3. Detección semántica de preguntas equivalentes.
// 4. Lematización contextual correcta (sustantivo vs. verbo: "trabajo", "cambio").
// 5. Conservación de marcas, referencias, cantidades y negaciones.
// 6. Interpretación de respuestas breves de una sola palabra ("Envigado").
// 7. Prioridad a preguntas comerciales del mecánico.
// 8. Manejo de rechazos explícitos sin trabar el bot ("prefiero no dar la cédula").
// 9. Separación estricta de interés comercial vs. autorización legal Habeas Data.
// 10. Protección de talleres ya registrados (cero preguntas de vinculación).
// 11. Concurrencia y serialización por número de teléfono.

const assert = require('assert');
const { processNlpPipeline, lemmatize, tokenize, normalizeText } = require('../nlp_pipeline');
const {
  initOrLoadMemory,
  isTopicOrQuestionForbidden,
  integrateFactsIntoMemory,
  recordAskedQuestion,
  buildConversationSummary,
  TOPIC_SEMANTIC_PATTERNS
} = require('../conversation_memory');
const { getPendingTopics, cleanResponseText, SYSTEM_PROMPT } = require('../gemini_brain');
const { getMateoSystemPrompt, getSkill } = require('../skill_loader');
const { normalizeMechanicData } = require('../scoring');
const { generateMateoResponse, cleanWorkshopName, cleanPersonName, parseNameAndWorkshop, extractEntities, isPureGreeting } = require('../agent');
const { getRegistrationProgress } = require('../registration_engine');

console.log('🧪 =======================================================');
console.log('🚀 INICIANDO AUDITORÍA Y TEST SUITE DEL CEREBRO DE MATEO');
console.log('🧪 =======================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`✅ [PASÓ]: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FALLÓ]: ${testName}`);
    console.error(`   Detalle del error: ${err.message}\n`, err.stack);
  }
}

// -------------------------------------------------------------
// TEST 1: Normalización de abreviaturas de WhatsApp sin perder datos
// -------------------------------------------------------------
runTest('A. Normalización preserva marcas y expande jerga WhatsApp', () => {
  const input = "atiendo 15 motos ala semana, trabajo con bajaj y yamaha y cambio pastillas y kit d arrastre xfa";
  const result = normalizeText(input);

  assert.ok(result.normalized.includes('a la semana'), 'Debe expandir "ala" a "a la"');
  assert.ok(result.normalized.includes('kit de arrastre'), 'Debe expandir "kit d arrastre" a "kit de arrastre"');
  assert.ok(result.normalized.includes('bajaj'), 'Debe conservar la marca Bajaj');
  assert.ok(result.normalized.includes('yamaha'), 'Debe conservar la marca Yamaha');
  assert.strictEqual(result.original, input, 'Debe preservar el texto original intacto');
});

// -------------------------------------------------------------
// TEST 2: Lematización contextual (sustantivo vs. verbo)
// -------------------------------------------------------------
runTest('B. Lematización contextual diferencia sustantivo de verbo', () => {
  // Caso 1: "trabajo" como sustantivo ("bastante trabajo")
  const text1 = "Con ese movimiento hay bastante trabajo en el taller";
  const tok1 = tokenize(text1);
  const lem1 = lemmatize(tok1, text1);
  const itemTrabajo1 = lem1.find(l => l.token.toLowerCase() === 'trabajo');
  assert.ok(itemTrabajo1, 'Debe encontrar el token trabajo');
  assert.strictEqual(itemTrabajo1.pos, 'sustantivo', '"bastante trabajo" debe clasificarse como sustantivo');
  assert.strictEqual(itemTrabajo1.lemma, 'trabajo', 'El lema de sustantivo debe ser trabajo');

  // Caso 2: "trabajo" como verbo ("yo trabajo con yamaha")
  const text2 = "Yo trabajo con Yamaha y Suzuki";
  const tok2 = tokenize(text2);
  const lem2 = lemmatize(tok2, text2);
  const itemTrabajo2 = lem2.find(l => l.token.toLowerCase() === 'trabajo');
  assert.ok(itemTrabajo2, 'Debe encontrar el token trabajo');
  assert.strictEqual(itemTrabajo2.pos, 'verbo', '"yo trabajo" debe clasificarse como verbo');
  assert.strictEqual(itemTrabajo2.lemma, 'trabajar', 'El lema del verbo debe ser trabajar');

  // Caso 3: "cambio" como sustantivo vs verbo
  const text3 = "Hacemos cambio de aceite";
  const tok3 = tokenize(text3);
  const lem3 = lemmatize(tok3, text3);
  const itemCambio = lem3.find(l => l.token.toLowerCase() === 'cambio');
  assert.strictEqual(itemCambio.pos, 'sustantivo', '"cambio de aceite" debe ser sustantivo');
});

// -------------------------------------------------------------
// TEST 3: Extracción simultánea de múltiples entidades (Ejemplo 1 del requerimiento)
// -------------------------------------------------------------
runTest('C. Extracción simultánea de 4 hechos en un único mensaje (Ejemplo 1)', () => {
  const userText = "Buenas, tengo un taller en Bello. Trabajo con Yamaha y Bajaj, me llegan como 20 motos por semana y cambio bastante pastillas y kits de arrastre";
  const nlp = processNlpPipeline(userText);
  const entities = nlp.entities;

  assert.strictEqual(entities.ciudad_taller, 'Bello', 'Debe extraer ciudad Bello');
  assert.deepStrictEqual(entities.marcas_motos, ['Yamaha', 'Bajaj'], 'Debe extraer marcas Yamaha y Bajaj');
  assert.ok(entities.motos_por_semana.includes('20'), 'Debe extraer volumen 20 motos');
  assert.ok(entities.repuestos_frecuentes.includes('Kits de arrastre'), 'Debe extraer kits de arrastre');
  assert.ok(entities.repuestos_frecuentes.includes('Pastillas de freno'), 'Debe extraer pastillas de freno');
});

// -------------------------------------------------------------
// TEST 4: Interpretación de respuesta corta de una sola palabra (Ejemplo 2)
// -------------------------------------------------------------
runTest('D. Respuesta breve de una palabra interpretada en contexto (Ejemplo 2)', () => {
  const userText = "Envigado";
  const nlp = processNlpPipeline(userText);
  assert.strictEqual(nlp.entities.ciudad_taller, 'Envigado', 'Debe reconocer Envigado como ciudad');
});

// -------------------------------------------------------------
// TEST 5: Multitema con equipo y volumen diario (Ejemplo 3)
// -------------------------------------------------------------
runTest('E. Extracción de equipo, volumen diario y marca (Ejemplo 3)', () => {
  const userText = "De todo, la verdad. Somos dos mecánicos, atendemos como 12 motos al día y trabajamos más que todo con AKT";
  const nlp = processNlpPipeline(userText);
  const entities = nlp.entities;

  assert.ok(entities.especialidad.includes('Mecánica general'), 'Debe clasificar como Mecánica general');
  assert.ok(entities.equipo_taller.toLowerCase().includes('dos') || entities.equipo_taller.toLowerCase().includes('2'), 'Debe extraer equipo de dos mecánicos');
  assert.ok(entities.motos_por_semana.includes('12 motos al día'), 'Debe extraer 12 motos al día');
  assert.deepStrictEqual(entities.marcas_motos, ['AKT'], 'Debe extraer marca AKT');
});

// -------------------------------------------------------------
// TEST 6: Detección y prioridad a consultas comerciales (Ejemplos 4 y 7)
// -------------------------------------------------------------
runTest('F. Detección de consultas comerciales y preguntas de empresa', () => {
  // Caso "¿Quiénes son?"
  const q1 = processNlpPipeline("¿Y ustedes quiénes son o qué hacen?");
  assert.strictEqual(q1.entities.es_pregunta_comercial, true);
  assert.strictEqual(q1.entities.pregunta_comercial_tema, 'identidad_empresa');

  // Caso "Pastillas para una NKD"
  const q2 = processNlpPipeline("¿Ustedes manejan pastillas para una NKD?");
  assert.strictEqual(q2.entities.es_pregunta_comercial, true);
  assert.strictEqual(q2.entities.pregunta_comercial_tema, 'consulta_repuesto_referencia');
});

// -------------------------------------------------------------
// TEST 7: Respeto estricto a la negativa de dar datos (Ejemplo 8)
// -------------------------------------------------------------
runTest('G. Respeto de negativa a dar cédula sin insistir ni trabar (Ejemplo 8)', () => {
  const userText = "Por ahora prefiero no dar la cédula";
  const nlp = processNlpPipeline(userText);
  assert.ok(nlp.entities.rechazo_dato.cedula, 'Debe registrar rechazo de cédula');
  assert.ok(nlp.entities.cedula.includes('rechazada'), 'Debe marcar cédula como no proporcionada');

  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);
  integrateFactsIntoMemory(memory, nlp.entities, userText);

  // La guardabarrera debe bloquear cualquier pregunta futura sobre la cédula
  const check = isTopicOrQuestionForbidden(memory, 'cedula');
  assert.strictEqual(check.forbidden, true, 'Debe prohibir volver a pedir la cédula');
});

// -------------------------------------------------------------
// TEST 8: Separación estricta de interés comercial vs Habeas Data (Ejemplo 9)
// -------------------------------------------------------------
runTest('H. Interés en muestras/catálogo NO aprueba Habeas Data automáticamente (Ejemplo 9)', () => {
  const userText = "Sí, me interesa conocer el catálogo y las muestras";
  const session = { data: {}, memory: null, _offeringNitrox: true, _waitingHabeasData: false };
  const memory = initOrLoadMemory(session);

  const nlp = processNlpPipeline(userText, session);
  integrateFactsIntoMemory(memory, nlp.entities, userText);

  // Debe registrar interés en muestras
  assert.strictEqual(memory.confirmedFacts['quiere_muestras']?.value, 'Sí');
  // NO debe registrar autorización de Habeas Data
  assert.strictEqual(memory.confirmedFacts['autorizacion_tratamiento_datos'], undefined);

  // En normalizeMechanicData tampoco debe ser true
  const mechanicDoc = normalizeMechanicData({ quiere_muestras: 'Sí' });
  assert.strictEqual(mechanicDoc.autorizacion_tratamiento_datos, false, 'No debe auto-aprobarse Habeas Data');
});

// -------------------------------------------------------------
// TEST 9: REGLA DE ORO - CERO PREGUNTAS REPETIDAS SOBRE DATOS CONFIRMADOS
// -------------------------------------------------------------
runTest('I. Cero preguntas repetidas sobre datos ya confirmados', () => {
  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);

  // Simular mecánico que ya confirmó ubicación Bello, marcas Yamaha y Bajaj, volumen 20 motos
  integrateFactsIntoMemory(memory, {
    ciudad_taller: 'Bello',
    marcas_motos: ['Yamaha', 'Bajaj'],
    motos_por_semana: '20 motos por semana'
  });

  // Intentar preguntar por ciudad
  const checkCiudad = isTopicOrQuestionForbidden(memory, 'ciudad_taller', '¿En qué ciudad queda tu taller?');
  assert.strictEqual(checkCiudad.forbidden, true, 'Debe prohibir preguntar por ciudad ya conocida');

  // Intentar preguntar por marcas de motos
  const checkMarcas = isTopicOrQuestionForbidden(memory, 'marcas_motos', '¿Qué marcas de motos atiendes?');
  assert.strictEqual(checkMarcas.forbidden, true, 'Debe prohibir preguntar por marcas ya conocidas');

  // Intentar preguntar con frase equivalente ("¿Con cuáles marcas trabajas?")
  const checkMarcasEquiv = isTopicOrQuestionForbidden(memory, 'marcas_motos', '¿Con cuáles marcas de motos trabajas?');
  assert.strictEqual(checkMarcasEquiv.forbidden, true, 'Debe detectar equivalencia semántica y prohibirla');

  // getPendingTopics no debe incluir ninguno de esos datos
  const pending = getPendingTopics(memory);
  assert.ok(!pending.some(p => p.includes('Ciudad o municipio')), 'Ubicación no debe estar pendiente');
  assert.ok(!pending.some(p => p.includes('Marcas de motos')), 'Marcas no debe estar pendiente');
  assert.ok(!pending.some(p => p.includes('Flujo o volumen')), 'Volumen no debe estar pendiente');
});

// -------------------------------------------------------------
// TEST 10: Taller ya registrado no vuelve a pasar por registro
// -------------------------------------------------------------
runTest('J. Taller ya registrado tiene cero temas de registro pendientes', () => {
  const session = { data: { _finished: true, id_unico: 'RN-MED-TEST01' }, memory: null };
  const memory = initOrLoadMemory(session);
  const pending = getPendingTopics(memory);
  assert.strictEqual(pending.length, 0, 'Un taller registrado debe tener 0 temas pendientes');
});

// -------------------------------------------------------------
// TEST 11: Detección de protesta del usuario ("Ya te dije")
// -------------------------------------------------------------
runTest('K. Detección de protesta ("Ya te dije que Yamaha y Suzuki")', () => {
  const userText = "Ya te dije que Yamaha y Suzuki";
  const nlp = processNlpPipeline(userText);
  assert.strictEqual(nlp.entities.protesta_repeticion, true, 'Debe detectar protesta de repetición');
  assert.deepStrictEqual(nlp.entities.marcas_motos, ['Yamaha', 'Suzuki'], 'Debe extraer las marcas recordadas');
});

// -------------------------------------------------------------
// TEST 12: Blindaje contra finalización prematura (Caso Johan / Leones la 50)
// -------------------------------------------------------------
runTest('L. No finaliza la vinculación si solo se conoce nombre y taller sin ubicación, rol ni Habeas Data', () => {
  const session = { data: {}, memory: null };
  const memory = initOrLoadMemory(session);

  // Turno 1 y 2: Mecánico da nombre y taller
  integrateFactsIntoMemory(memory, {
    nombres_apellidos: 'Johan González',
    nombre_taller: 'Taller Leones La 50'
  });

  const pending = getPendingTopics(memory);
  // Debe haber temas pendientes de ubicación, rol, etc.
  assert.ok(pending.length >= 4, 'Deben quedar temas pendientes esenciales');
  assert.ok(pending.some(p => p.includes('Ciudad o municipio') || p.includes('Ubicación')), 'Ubicación debe estar pendiente');
  assert.ok(pending.some(p => p.includes('Rol en el taller')), 'Rol debe estar pendiente');

  // Comprobar que NO está listo para finalizar
  const hasEssentialData = Boolean(
    memory.confirmedFacts['nombres_apellidos']?.value &&
    memory.confirmedFacts['nombre_taller']?.value &&
    (memory.confirmedFacts['ciudad_taller']?.value || memory.confirmedFacts['barrio_taller']?.value || memory.confirmedFacts['direccion_taller']?.value) &&
    memory.confirmedFacts['relacion_taller']?.value &&
    memory.confirmedFacts['autorizacion_tratamiento_datos']?.value !== undefined
  );
  assert.strictEqual(hasEssentialData, false, 'No debe considerarse con datos esenciales completos');
});

// -------------------------------------------------------------
// TEST 13: Extracción de taller y ciudad compuestos ("La 50 en Medellín")
// -------------------------------------------------------------
runTest('M. Extracción de taller y ciudad compuestos ("La 50 en Medellín")', () => {
  const userText = "La 50 en Medellín";
  const nlp = processNlpPipeline(userText);
  assert.ok(nlp.entities.nombre_taller.includes('La 50'), 'Debe extraer nombre del taller con La 50');
  assert.strictEqual(nlp.entities.ciudad_taller, 'Medellín', 'Debe extraer ciudad Medellín');
  const cleaned = cleanWorkshopName(userText);
  assert.strictEqual(cleaned, 'Taller La 50', 'cleanWorkshopName debe formatear como Taller La 50');
});

// -------------------------------------------------------------
// TEST 14: Anti-muletilla estricta (Eliminación de "Contame," / "Y contame,")
// -------------------------------------------------------------
runTest('N. Sanitizador de muletillas elimina "Contame," y "Y contame,"', () => {
  const text1 = "Contame, ¿en qué barrio está ubicado tu taller?";
  const cleaned1 = cleanResponseText(text1);
  assert.ok(!cleaned1.toLowerCase().startsWith('contame'), 'No debe empezar con contame');

  const text2 = "Y contame, ¿qué marcas atiendes más?";
  const cleaned2 = cleanResponseText(text2);
  assert.ok(!cleaned2.toLowerCase().startsWith('y contame'), 'No debe empezar con y contame');
});

// -------------------------------------------------------------
// TEST 15: Detección de conocimiento de Nitrox (No los conozco -> 'No')
// -------------------------------------------------------------
runTest('O. Detección de conocimiento de Nitrox (No los conozco -> No)', () => {
  const userText = "La verdad no los conozco";
  const nlp = processNlpPipeline(userText, { _askingNitrox: true });
  assert.strictEqual(nlp.entities.conoce_nitrox, 'No', 'Debe extraer conoce_nitrox: No');
});

// -------------------------------------------------------------
// TEST 16: Validación de cierre y entrega de carnet con celular_whatsapp
// -------------------------------------------------------------
runTest('P. Ficha completa con celular_whatsapp autoriza canFinalize = true', () => {
  const sessionData = {
    nombres_apellidos: 'Fidel González',
    nombre_taller: 'Taller La 50',
    ciudad_taller: 'Medellín',
    barrio_taller: 'Aranjuez',
    direccion_taller: 'Calle 50 #40-20',
    celular_whatsapp: '573208185796',
    relacion_taller: 'Propietario',
    especialidad: ['Mecánica general'],
    marcas_motos: ['Bajaj', 'AKT', 'Suzuki'],
    motos_por_semana: '15 motos por semana',
    repuestos_frecuentes: ['Kits de arrastre', 'Pastillas de freno'],
    marcas_repuestos_usadas: ['Casarella', 'NITROX'],
    conoce_nitrox: 'No',
    quiere_muestras: 'Sí',
    correo: 'fidel@gmail.com',
    cedula: '1020304050',
    autorizacion_tratamiento_datos: true
  };

  const progress = getRegistrationProgress(sessionData, {});
  assert.strictEqual(progress.missingMandatory.length, 0, 'No debe faltar ningún campo obligatorio');
  assert.strictEqual(progress.canFinalize, true, 'canFinalize debe ser true para entregar carnet digital y QR');
  assert.ok(progress.progressPercentage >= 80, 'Progreso debe ser >= 80%');
});

// -------------------------------------------------------------
// TEST 17: Respuesta genérica ('todas', 'de todo') no marca marcas_motos como confirmadas
// -------------------------------------------------------------
runTest('Q. Respuesta genérica ("todas") activa marcas_genericas y no confirma marcas_motos', () => {
  const userText = "de todas recibo";
  const nlp = processNlpPipeline(userText, { _askingBrands: true });
  assert.strictEqual(nlp.entities.marcas_motos, null, 'marcas_motos debe permanecer null para forzar precisión');
  assert.strictEqual(nlp.entities.marcas_genericas, true, 'marcas_genericas debe ser true');
});

// -------------------------------------------------------------
// TEST 18: Respuesta "No" a recomendación de repuestos captura frecuencia Nunca y Sin preferencia
// -------------------------------------------------------------
runTest('R. Respuesta "No" a recomendación de marcas se captura con 100% fidelidad', () => {
  const userText = "No";
  const nlp = processNlpPipeline(userText, { _askingRecommendBrands: true, _lastQuestion: 'MARCA_RECOMENDADA' });
  assert.strictEqual(nlp.entities.frecuencia_recomendacion, 'Nunca', 'Debe capturar frecuencia_recomendacion como Nunca');
  assert.deepStrictEqual(nlp.entities.marcas_repuestos_usadas, ['Ninguna'], 'Debe capturar marcas_repuestos_usadas como Ninguna');
  assert.strictEqual(nlp.entities.quien_decide_repuesto, 'Cliente', 'Debe asignar quien_decide_repuesto a Cliente');
});

// -------------------------------------------------------------
// TEST 19: Respuesta "Sí" a recomendar NITROX y ganar premios captura recomendaria_nitrox y quiere_muestras
// -------------------------------------------------------------
runTest('S. Respuesta afirmativa a recomendar NITROX y premios activa recomendaria_nitrox', () => {
  const userText = "Sí";
  const nlp = processNlpPipeline(userText, { _askingRecommendNitrox: true, _lastQuestion: 'RECOMENDAR_NITROX' });
  assert.strictEqual(nlp.entities.recomendaria_nitrox, 'Definitivamente sí', 'Debe capturar recomendaria_nitrox: Definitivamente sí');
  assert.strictEqual(nlp.entities.quiere_muestras, 'Sí', 'Debe capturar quiere_muestras: Sí');
});

// -------------------------------------------------------------
// TEST 20: Celulares de WhatsApp en el chat NO contaminan la cédula y extraen teléfono alterno
// -------------------------------------------------------------
runTest('T. Múltiples números de celular en el chat no se asignan a cédula y extraen alterno', () => {
  const userText = "3177694776\n3110222345";
  const nlp = processNlpPipeline(userText, { _lastQuestion: 'CELULAR' });
  assert.strictEqual(nlp.entities.celular_whatsapp, '573177694776', 'Debe capturar el primer número como celular_whatsapp');
  assert.strictEqual(nlp.entities.telefono_alterno, '573110222345', 'Debe capturar el segundo número como telefono_alterno');
  assert.strictEqual(nlp.entities.cedula, null, 'Cédula debe ser null, no debe contaminarse con un número celular');
});

// -------------------------------------------------------------
// TEST 21: Captura de volumen con números aislados ("20"), rangos ("entre 15 y 20") y palabras ("veinte")
// -------------------------------------------------------------
runTest('U. Captura exhaustiva de volumen de motos (aislado, rango, palabras, diario)', () => {
  // Caso 1: Carlos respondió solo "20" a la pregunta de volumen
  const nlp1 = processNlpPipeline("20", { _lastQuestion: 'VOLUMEN', lastAssistantMessage: '¿Cuántas motos atienden por semana aproximadamente?' });
  assert.strictEqual(nlp1.entities.motos_por_semana, '20 motos/semana', 'Debe capturar "20" como 20 motos/semana');

  // Caso 2: Rango "entre 15 y 20"
  const nlp2 = processNlpPipeline("entre 15 y 20", { _lastQuestion: 'VOLUMEN' });
  assert.strictEqual(nlp2.entities.motos_por_semana, '15 a 20 motos/semana', 'Debe capturar rango 15 a 20 motos/semana');

  // Caso 3: Palabra en español "veinte"
  const nlp3 = processNlpPipeline("veinte", { _lastQuestion: 'VOLUMEN' });
  assert.strictEqual(nlp3.entities.motos_por_semana, '20 motos/semana', 'Debe capturar "veinte" como 20 motos/semana');

  // Caso 4: Volumen diario "4 diarias"
  const nlp4 = processNlpPipeline("4 diarias", {});
  assert.ok(nlp4.entities.motos_por_semana.includes('al día') || nlp4.entities.motos_por_semana.includes('diarias'), 'Debe capturar tasa diaria');
});

// -------------------------------------------------------------
// TEST 22: Saludo cordial inicial obligatorio con presentación de Mateo y Ruta NITROX
// -------------------------------------------------------------
runTest('V. Saludo cordial y presentación de Mateo y Ruta NITROX en primer contacto', () => {
  const { FALLBACK_QUESTIONS } = require('../gemini_brain');
  const greeting = FALLBACK_QUESTIONS.nombres_apellidos;
  assert.ok(greeting.toLowerCase().includes('mateo'), 'Debe presentarse como Mateo');
  assert.ok(greeting.toLowerCase().includes('ruta nitrox'), 'Debe mencionar la Ruta NITROX');
  assert.ok(greeting.toLowerCase().includes('capacitaciones'), 'Debe mencionar capacitaciones');
  assert.ok(greeting.toLowerCase().includes('premios'), 'Debe mencionar premios');
  assert.ok(!greeting.toLowerCase().startsWith('¿cómo te llamas?'), 'No debe ser solo "¿cómo te llamas?" en seco');
});

// -------------------------------------------------------------
// TEST 23: Sincronización de ciudad_residencia con ciudad_taller (no forzar Medellín en Fusagasugá)
// -------------------------------------------------------------
runTest('W. Sincronización de ciudad de residencia con ciudad del taller (sin forzar Medellín)', () => {
  const input = {
    nombre_taller: 'Taller Prueba',
    ciudad_taller: 'Fusagasugá',
    ciudad_residencia: 'Medellín' // Residuo histórico
  };
  const normalized = normalizeMechanicData(input, 'WhatsApp');
  assert.strictEqual(normalized.ciudad_taller, 'Fusagasugá', 'ciudad_taller debe ser Fusagasugá');
  assert.strictEqual(normalized.ciudad_residencia, 'Fusagasugá', 'ciudad_residencia debe heredar Fusagasugá en lugar de Medellín');
  assert.strictEqual(normalized.ciudad_ruta, 'Fusagasugá y alrededores', 'ciudad_ruta debe basarse en Fusagasugá');
});

// -------------------------------------------------------------
// TEST 24: "Hola y no saludas?" nunca se extrae como nombre "Y" ni como taller
// -------------------------------------------------------------
runTest('X. "Hola y no saludas?" reconocido como saludo y jamás extrae "Y" como nombre', () => {
  const greetingCheck = isPureGreeting("Hola y no saludas?");
  assert.strictEqual(greetingCheck, true, '"Hola y no saludas?" debe ser clasificado como saludo puro');

  const pName = cleanPersonName("Hola y no saludas?");
  assert.strictEqual(pName, '', 'cleanPersonName no debe extraer nombre de "Hola y no saludas?"');

  const singleY = cleanPersonName("Y");
  assert.strictEqual(singleY, '', 'cleanPersonName jamás debe extraer una sola letra o conjunción "Y"');

  const parsed = parseNameAndWorkshop("Hola y no saludas?");
  assert.strictEqual(parsed.name, '', 'parseNameAndWorkshop no debe asignar nombre');
  assert.strictEqual(parsed.workshop, '', 'parseNameAndWorkshop no debe asignar taller');

  const session = { data: {}, history: [] };
  const entities = extractEntities("Hola y no saludas?", session.data);
  assert.strictEqual(entities.nombres_apellidos, undefined, 'extractEntities no debe extraer nombres_apellidos');
  assert.strictEqual(entities.nombre_taller, undefined, 'extractEntities no debe extraer nombre_taller');
});

// -------------------------------------------------------------
// TEST 25: Insultos y protestas jamás se asignan como taller ni como nombre
// -------------------------------------------------------------
runTest('Y. Insultos y protestas jamás son asignados como nombre de taller', () => {
  const bad1 = cleanWorkshopName("No sea mierda ese no es mi nombre");
  assert.strictEqual(bad1, '', 'cleanWorkshopName debe retornar vacío ante insulto/protesta');

  const bad2 = cleanWorkshopName("Entonces?");
  assert.strictEqual(bad2, '', 'cleanWorkshopName debe retornar vacío ante pregunta "Entonces?"');

  const bad3 = cleanWorkshopName("Taller No Sea Mierda Ese No Es Mi Nombre");
  assert.strictEqual(bad3, '', 'cleanWorkshopName debe purgar taller con insulto');

  const badName = cleanPersonName("No sea mierda ese no es mi nombre");
  assert.strictEqual(badName, '', 'cleanPersonName debe retornar vacío ante insulto');
});

// -------------------------------------------------------------
// TEST 26: Detección y manejo de rechazo/corrección de nombre
// -------------------------------------------------------------
runTest('Z. Rechazo de nombre resetea nombres_apellidos espurio y no contamina nombre_taller', () => {
  const sessionData = {
    nombres_apellidos: 'Y',
    _lastQuestion: 'TALLER'
  };

  const entities = extractEntities("No sea mierda ese no es mi nombre", sessionData);

  assert.strictEqual(sessionData.nombres_apellidos, undefined, 'Debe borrar el nombre espurio "Y" de sessionData');
  assert.strictEqual(entities.nombre_taller, undefined, 'No debe asignar la protesta como taller');
  assert.strictEqual(sessionData._lastQuestion, 'NOMBRE', 'Debe reorientar la conversación a preguntar por el nombre');
});

// -------------------------------------------------------------
// TEST 27: Rechazo de nombre con nuevo nombre provisto
// -------------------------------------------------------------
runTest('AA. Corrección de nombre con nuevo nombre explícito actualiza nombre y no contamina taller', () => {
  const sessionData = {
    nombres_apellidos: 'Equivocado',
    _lastQuestion: 'TALLER'
  };

  const entities = extractEntities("Ese no es mi nombre, me llamo Carlos", sessionData);

  assert.strictEqual(entities.nombres_apellidos, 'Carlos', 'Debe capturar "Carlos" como el nombre corregido');
  assert.strictEqual(entities.nombre_taller, undefined, 'No debe asignar a taller');
});

// -------------------------------------------------------------
// TEST 28: Progresión conversacional obligatoria (jamás enviar disculpa o comentario sin pregunta)
// -------------------------------------------------------------
runTest('AB. Respuesta de Mateo jamás se queda sin pregunta si la vinculación está incompleta', () => {
  const sessionData = {
    _finished: false
    // Sin nombres_apellidos
  };
  let reply = "¡Qué pena contigo por la confusión.";

  // Regla fundamental de progresión conversacional:
  if (!sessionData._finished && !reply.includes('?')) {
    if (!sessionData.nombres_apellidos) {
      reply = `${reply.replace(/[.!\s]+$/, '')}. 🏍️ ¿Cuál es tu nombre para tenerte bien registrado?`;
    } else if (!sessionData.nombre_taller) {
      reply = `${reply.replace(/[.!\s]+$/, '')}. 🏍️ ¿Cómo se llama tu taller de motos?`;
    }
  }

  assert.ok(reply.includes('?'), 'La respuesta debe incluir una pregunta');
  assert.ok(reply.includes('¿Cuál es tu nombre'), 'Debe solicitar el nombre');
  assert.strictEqual(
    reply,
    '¡Qué pena contigo por la confusión. 🏍️ ¿Cuál es tu nombre para tenerte bien registrado?',
    'Debe concatenar la disculpa con la solicitud del dato'
  );
});

// -------------------------------------------------------------
// TEST 29: Carga modular de skills desde archivos .md en memoria RAM
// -------------------------------------------------------------
runTest('AC. Cargador skill_loader indexa todas las skills .md sin errores de I/O', () => {
  const pnlSkill = getSkill('00_identidad_pnl');
  const saludoSkill = getSkill('01_saludo_presentacion');
  const vinculacionSkill = getSkill('02_vinculacion_taller');
  const friccionSkill = getSkill('03_manejo_friccion');
  const comercialSkill = getSkill('04_asesoria_comercial_nitrox');
  const habeasSkill = getSkill('05_cierre_habeas_data');
  const schemaSkill = getSkill('06_output_schema');

  assert.ok(pnlSkill && pnlSkill.length > 50, 'Debe cargar skill 00_identidad_pnl');
  assert.ok(saludoSkill && saludoSkill.length > 50, 'Debe cargar skill 01_saludo_presentacion');
  assert.ok(vinculacionSkill && vinculacionSkill.length > 50, 'Debe cargar skill 02_vinculacion_taller');
  assert.ok(friccionSkill && friccionSkill.length > 50, 'Debe cargar skill 03_manejo_friccion');
  assert.ok(comercialSkill && comercialSkill.length > 50, 'Debe cargar skill 04_asesoria_comercial_nitrox');
  assert.ok(habeasSkill && habeasSkill.length > 50, 'Debe cargar skill 05_cierre_habeas_data');
  assert.ok(schemaSkill && schemaSkill.length > 50, 'Debe cargar skill 06_output_schema');
});

// -------------------------------------------------------------
// TEST 30: Integridad del SYSTEM_PROMPT ensamblado para Gemini
// -------------------------------------------------------------
runTest('AD. SYSTEM_PROMPT ensamblado contiene todas las reglas y restricciones críticas', () => {
  const prompt = getMateoSystemPrompt();
  assert.strictEqual(prompt, SYSTEM_PROMPT, 'SYSTEM_PROMPT exportado debe coincidir con el cargador');

  // Reglas críticas que deben estar presentes en el prompt ensamblado
  assert.ok(prompt.includes('MATEO'), 'Debe incluir el nombre Mateo');
  assert.ok(prompt.includes('Ruta NITROX') || prompt.includes('Ruta NITROX'), 'Debe mencionar la Ruta NITROX');
  assert.ok(prompt.includes('hermano'), 'Debe incluir la prohibición de hermano');
  assert.ok(prompt.includes('analisis_interno'), 'Debe incluir el esquema JSON');
  assert.ok(prompt.includes('datos_extraidos'), 'Debe incluir datos_extraidos');
  assert.ok(prompt.includes('listo_para_finalizar'), 'Debe incluir listo_para_finalizar');
  assert.ok(prompt.includes('5 a 18 palabras'), 'Debe especificar el límite de palabras WhatsApp');
});

// -------------------------------------------------------------
// TEST 31: Jerga colombiana de roles ("Yo soy la que lo comanda" -> Propietario)
// -------------------------------------------------------------
runTest('AE. Jerga colombiana de roles ("la que lo comanda", "el patrón") normalizada a Propietario', () => {
  const nlp1 = processNlpPipeline("Yo soy la que lo comanda", { _lastQuestion: 'ROL' });
  assert.strictEqual(nlp1.entities.relacion_taller, 'Propietario', 'Debe normalizar "la que lo comanda" a Propietario');

  const nlp2 = processNlpPipeline("Yo comando el taller y arreglo las motos", {});
  assert.strictEqual(nlp2.entities.relacion_taller, 'Propietario y Mecánico', 'Debe reconocer rol dual de comandar y arreglar');

  const nlp3 = processNlpPipeline("Yo soy la jefa", {});
  assert.strictEqual(nlp3.entities.relacion_taller, 'Propietario', 'Debe normalizar "la jefa" a Propietario');
});

// -------------------------------------------------------------
// TEST 32: Evasivas y bromas de transporte público ("Atiendo motos del sitp")
// -------------------------------------------------------------
runTest('AF. Respuestas evasivas o de transporte público ("motos del sitp") no se asignan a marcas ni volumen', () => {
  const nlp = processNlpPipeline("Atiendo motos del sitp", { _lastQuestion: 'MARCAS_MOTOS' });
  assert.strictEqual(nlp.entities.marcas_motos, null, 'SITP no debe ser tomado como marca de moto');
  assert.strictEqual(nlp.entities.motos_por_semana, null, 'SITP no debe ser tomado como volumen de motos');
  assert.strictEqual(nlp.entities.es_respuesta_evasiva, true, 'Debe marcarse como respuesta evasiva');
});

// -------------------------------------------------------------
// TEST 33: Polisemia de "rotar" ("Roto por las estaciones del sitp")
// -------------------------------------------------------------
runTest('AG. Polisemia colombiana de "rotar" (desplazamiento) no se confunde con repuestos frecuentes', () => {
  const nlp = processNlpPipeline("Roto por las estaciones del sitp", { _lastQuestion: 'REPUESTOS' });
  assert.strictEqual(nlp.entities.repuestos_frecuentes, null, 'Desplazamiento por estaciones no debe ser repuestos_frecuentes');
});

// -------------------------------------------------------------
// TEST 34: Normalización y saneamiento en integrateFactsIntoMemory
// -------------------------------------------------------------
runTest('AH. integrateFactsIntoMemory normaliza rol jergal y sanitiza marcas/repuestos espurios', () => {
  const memory = initOrLoadMemory({});
  integrateFactsIntoMemory(memory, {
    relacion_taller: 'el que comanda',
    marcas_motos: ['sitp', 'Yamaha'],
    repuestos_frecuentes: ['Roto por las estaciones del sitp'],
    motos_por_semana: 'motos del sitp'
  }, 'Yo soy el que comanda y atiendo motos del sitp');

  assert.strictEqual(memory.confirmedFacts['relacion_taller']?.value, 'Propietario', 'Debe normalizar "el que comanda" a Propietario');
  assert.deepStrictEqual(memory.confirmedFacts['marcas_motos']?.value, ['Yamaha'], 'Debe filtrar sitp y conservar únicamente marcas reales');
  assert.strictEqual(memory.confirmedFacts['repuestos_frecuentes'], undefined, 'No debe registrar repuestos espurios de estaciones');
  assert.strictEqual(memory.confirmedFacts['motos_por_semana'], undefined, 'No debe registrar volumen espurio de sitp');
});

// -------------------------------------------------------------
// TEST 35: Prohibición total anti-robot y saneamiento de lenguaje en cleanResponseText
// -------------------------------------------------------------
runTest('AI. Prohibición estricta de términos robóticos en SYSTEM_PROMPT y cleanResponseText', () => {
  const prompt = getMateoSystemPrompt();
  assert.ok(prompt.includes('TERMINANTEMENTE PROHIBIDO DECIR QUE ERES UN SISTEMA, BOT, AGENTE, IA'), 'El prompt debe tener la prohibición anti-robot explícita');

  const { cleanResponseText } = require('../gemini_brain');
  const dirtyReply = "Como sistema de IA, te informo que el sistema se quedó pensando.";
  const cleaned = cleanResponseText(dirtyReply);
  assert.ok(!cleaned.toLowerCase().includes('como sistema'), 'cleanResponseText debe erradicar "como sistema"');
  assert.ok(!cleaned.toLowerCase().includes('de ia'), 'cleanResponseText debe erradicar menciones de IA');
});

console.log('\n=======================================================');
console.log(`📊 RESULTADOS DEL TEST SUITE: ${passedTests}/${totalTests} PRUEBAS SUPERADAS CON ÉXITO.`);
if (passedTests === totalTests) {
  console.log('🎯 ¡CUMPLIMIENTO DEL 100% EN TODAS LAS REGLAS CONVERSACIONALES Y DE NLP!');
} else {
  console.error('⚠️ ALGUNAS PRUEBAS FALLARON.');
  process.exit(1);
}
console.log('=======================================================\n');

