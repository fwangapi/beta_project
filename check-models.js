require('dotenv').config();

async function listModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  
  if (data.models) {
    console.log("Supported generateContent models on your key:");
    data.models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .forEach(m => console.log(`- ${m.name.replace('models/', '')}`));
  } else {
    console.error("Failed to fetch models:", data);
  }
}

listModels();