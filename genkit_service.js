require('dotenv').config();
const { genkit } = require('genkit');
const { googleAI } = require('@genkit-ai/googleai');
const { enableFirebaseTelemetry } = require('@genkit-ai/firebase');

if (!global.__GENKIT_TELEMETRY_INITIALIZED) {
  global.__GENKIT_TELEMETRY_INITIALIZED = true;
  enableFirebaseTelemetry({
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'agente-nitrox',
    metricExportIntervalMillis: 5000,
    metricExportTimeoutMillis: 5000,
    forceDevExport: true
  });
}

const API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;

const ai = genkit({
  plugins: [googleAI({ apiKey: API_KEY })],
  model: 'googleai/gemini-flash-lite-latest',
});

// Flow example
const helloFlow = ai.defineFlow('helloFlow', async (name) => {
  const { text } = await ai.generate(`Hello Gemini, my name is ${name}`);
  return text;
});

module.exports = {
  ai,
  helloFlow
};
