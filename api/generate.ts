import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

function chooseModel(prompt: string) {
  const codeKeywords = [
    "app",
    "code",
    "swift",
    "build",
    "function",
    "generate",
    "api"
  ];
  const containsCode = codeKeywords.some(k =>
    prompt.toLowerCase().includes(k)
  );
  if (containsCode || prompt.length > 2000) {
    return "claude";
  }
  return "openai";
}

export default async function handler(req, res) {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  const model = chooseModel(prompt);
  try {
    if (model === "claude") {
      const message = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      });
      return res.json({
        text: message.content[0].text,
        model: "claude"
      });
    } else {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 4000
      });
      return res.json({
        text: completion.choices[0].message.content,
        model: "openai"
      });
    }
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Failed to generate response" });
  }
}
