const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

export function isGeminiEnabled() {
  return !!API_KEY && API_KEY !== 'paste_your_gemini_key_here';
}

export async function analyzeMeasurements(garmentLabel, measurements, lang = 'en') {
  if (!isGeminiEnabled()) return null;
  const langNote = lang === 'ml' ? 'Reply in Malayalam language.' : 'Reply in English.';
  const lines = Object.entries(measurements).map(([k,v]) => `${k}: ${v} cm`).join(', ');
  const prompt = `You are TailorBee's AI tailor assistant for Indian clothing. ${langNote}
The customer measured for: ${garmentLabel}.
Measurements: ${lines}.
Give a warm 2-sentence analysis. Flag anything unusual. End with one fit tip. Keep it under 60 words.`;

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 120, temperature: 0.7 },
      }),
    });
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch { return null; }
}
