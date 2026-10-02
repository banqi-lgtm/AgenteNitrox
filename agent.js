const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin for Firestore
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: 'agente-nitrox'
    });
  } catch (e) {
    console.warn('Firebase Admin warning:', e.message);
  }
}

const DB_FILE = path.join(__dirname, 'conversations.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading local DB:', e);
  }
  return {};
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving local DB:', e);
  }
}

async function saveLeadToFirestore(phone, data) {
  try {
    const firestore = admin.firestore();
    await firestore.collection('talleres_aliados').doc(phone).set({
      telefono: phone,
      nombre_taller: data.workshopName || '',
      ubicacion: data.location || '',
      personal: data.teamSize || '',
      maquinaria: data.equipment || '',
      fecha_registro: new Date().toISOString()
    }, { merge: true });
    console.log(`✅ [FIRESTORE] Taller "${data.workshopName}" guardado en la base de datos de Firebase!`);
  } catch (err) {
    console.warn('[FIRESTORE]', err.message);
  }
}

// Regex to capture affiliation / registration intent
const AFFILIATION_REGEX = /(afilia|registr|unir|inscrib|aliad|taller|ingresa|pertenec|hacer parte|socio|empez|arranc|si|claro|hagale|hágale|de una|dar de alta|vengo)/i;

async function generateMateoResponse(fromNumber, userText) {
  const db = loadDB();
  if (!db[fromNumber]) {
    db[fromNumber] = {
      stage: 'INIT',
      data: {},
      history: []
    };
  }

  const session = db[fromNumber];
  session.history.push({ role: 'user', content: userText, timestamp: Date.now() });

  const textLower = userText.toLowerCase().trim();
  let messagesToSend = [];

  // Check if LLM (Gemini or OpenAI) is configured
  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: getSystemPrompt()
      });

      const contents = session.history.slice(-10).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));

      const result = await model.generateContent({ contents });
      const reply = result.response.text();
      messagesToSend = splitIntoBubbles(reply);
      
      session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      saveDB(db);
      return messagesToSend;
    } catch (err) {
      console.error('Error calling Gemini, falling back to local Mateo engine:', err.message);
    }
  } else if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: getSystemPrompt() },
          ...session.history.slice(-10).map(msg => ({
            role: msg.role,
            content: msg.content
          }))
        ]
      });
      const reply = completion.choices[0].message.content;
      messagesToSend = splitIntoBubbles(reply);
      session.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      saveDB(db);
      return messagesToSend;
    } catch (err) {
      console.error('Error calling OpenAI, falling back to local Mateo engine:', err.message);
    }
  }

  // --- Natural Paisa Conversational Engine (NITROX) ---
  if (session.stage === 'INIT') {
    if (AFFILIATION_REGEX.test(textLower)) {
      messagesToSend = [
        '¡Qué más pues! Qué elegancia que quieras hacer parte de la red de Talleres Aliados NITROX.',
        'De una, vamos a hacer unas pregunticas bien breves para dejarte listo en el sistema.',
        'Contame primero, ¿cómo se llama tu taller?'
      ];
      session.stage = 'ASK_WORKSHOP_NAME';
    } else {
      messagesToSend = [
        '¡Hola! Mi nombre es Mateo, soy asesor comercial de Talleres NITROX.',
        'Cuéntame, ¿en qué te puedo colaborar hoy?'
      ];
      session.stage = 'AWAITING_INTENT';
    }
  } else if (session.stage === 'AWAITING_INTENT') {
    if (AFFILIATION_REGEX.test(textLower)) {
      messagesToSend = [
        '¡Hágale pues, de una! Qué bueno tenerte por acá.',
        'Vamos a hacer unas pregunticas bien puntuales para dejarte registrado en la red de NITROX.',
        'Primero que todo, ¿cómo se llama tu taller?'
      ];
      session.stage = 'ASK_WORKSHOP_NAME';
    } else {
      messagesToSend = [
        '¡Listo pariente! Con todo el gusto te ayudo.',
        'Si vienes a afiliarte como taller aliado de NITROX, avisame y arrancamos de una con las preguntas.'
      ];
    }
  } else if (session.stage === 'ASK_WORKSHOP_NAME') {
    session.data.workshopName = userText;
    messagesToSend = [
      '¡Qué buen nombre, ' + userText + '! Bacano.',
      'Y contame, ¿en qué ciudad están y cuál es la dirección del taller?'
    ];
    session.stage = 'ASK_LOCATION';
  } else if (session.stage === 'ASK_LOCATION') {
    session.data.location = userText;
    messagesToSend = [
      'Listo, ya me quedó anotada la dirección.',
      'Decime una cosa: ¿más o menos cuántas personas o mecánicos trabajan con vos allá en el taller?'
    ];
    session.stage = 'ASK_TEAM_SIZE';
  } else if (session.stage === 'ASK_TEAM_SIZE') {
    session.data.teamSize = userText;
    messagesToSend = [
      'Excelente equipo, hermano.',
      'Ahora contame un poco sobre las herramientas y maquinaria que tienen.',
      'Por ejemplo: ¿tienen elevadores hidráulicos, escáner automotriz, desmontadora de llantas, torno o prensa? Decime con qué equipos cuentan.'
    ];
    session.stage = 'ASK_EQUIPMENT';
  } else if (session.stage === 'ASK_EQUIPMENT') {
    session.data.equipment = userText;
    messagesToSend = [
      '¡Uff, completísimo! Tienen muy buen equipo de trabajo.',
      'Hermano, ya te tomé todos los datos iniciales:\n\n• Taller: ' + session.data.workshopName + '\n• Ubicación: ' + session.data.location + '\n• Personal: ' + session.data.teamSize + '\n• Maquinaria: ' + session.data.equipment,
      'Con esto ya te paso a nuestra lista de talleres aliados NITROX para darte de alta. En un ratico te estamos contactando con los siguientes pasos y beneficios. ¡Cualquier cosa me avisas pues!'
    ];
    session.stage = 'COMPLETED';

    // Save lead to Firestore automatically!
    saveLeadToFirestore(fromNumber, session.data);

  } else if (session.stage === 'COMPLETED') {
    messagesToSend = [
      '¡Hola de nuevo pariente! Tus datos ya quedaron súper bien radicados en NITROX.',
      '¿Necesitas que revisemos algún dato o te puedo colaborar con alguna otra duda?'
    ];
  }

  session.history.push({ role: 'assistant', content: messagesToSend.join(' '), timestamp: Date.now() });
  saveDB(db);

  return messagesToSend;
}

function getSystemPrompt() {
  return `Eres Mateo, asesor comercial de Talleres NITROX.
Tu personalidad es 100% PAISA: muy natural, cálido, relajado, formal pero cercano (como un paisa de Medellín educado y profesional hablando por WhatsApp).
Usa expresiones paisas colombianas muy naturales con moderación y fluidez: "qué más pues", "bien o qué", "pariente", "con todo gusto", "hágale pues", "de una", "bacano", "hermano".
IMPORTANTE:
- La marca es siempre NITROX (o Talleres NITROX).
- NO hables como un robot ni como una IA.
- Tu misión principal es registrar y afiliar al cliente como Taller Aliado NITROX.
- Debes pedir la información PASO A PASO, haciendo UNA sola pregunta a la vez:
  1. Saludo inicial si no ha dicho su intención.
  2. Si quiere afiliarse o registrarse: darle la bienvenida con entusiasmo paisa y preguntarle cómo se llama el taller.
  3. Preguntar dirección y ciudad.
  4. Preguntar cuántas personas trabajan en el taller.
  5. Preguntar qué maquinaria y equipos tienen (dándole ejemplos cotidianos: elevadores hidráulicos, escáner automotriz, desmontadora, compresor, torno, alineadora, etc.).
  6. Confirmarle con alegría que sus datos quedaron registrados para la red de aliados NITROX.
- Respuestas breves y humanas.`;
}

function splitIntoBubbles(text) {
  const parts = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

module.exports = {
  generateMateoResponse
};
