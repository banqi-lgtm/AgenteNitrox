require('dotenv').config();
const { genkit } = require('genkit');
const { googleAI, gemini15Flash } = require('@genkit-ai/googleai');

// Ensure apiKey is mapped if set as GEMINI_API_KEY
if (!process.env.GOOGLE_GENAI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENAI_API_KEY = process.env.GEMINI_API_KEY;
}

const ai = genkit({
  plugins: [googleAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY })],
  model: gemini15Flash,
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
