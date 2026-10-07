import 'dotenv/config';
import { gemini15Flash, googleAI } from '@genkit-ai/googleai';
import { genkit } from 'genkit';

const ai = genkit({
  plugins: [googleAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY })],
  model: gemini15Flash,
});

export const helloFlow = ai.defineFlow('helloFlow', async (name) => {
  const { text } = await ai.generate(`Hello Gemini, my name is ${name}`);
  console.log(text);
  return text;
});

// Run directly if invoked from CLI
if (process.argv[1] && process.argv[1].includes('sample_genkit.mjs')) {
  helloFlow('Chris').catch(console.error);
}
