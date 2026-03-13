import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Simple in-memory rate limiting (resets on deployment)
const requestCounts = new Map<string, { count: number; resetTime: number }>();

// Rate limiting: 20 requests per hour per IP
const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  
  if (record.count >= RATE_LIMIT) {
    return false;
  }
  
  record.count++;
  return true;
}

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

// Timeout wrapper for AI requests
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}

export default async function handler(req, res) {
  // Get IP address for rate limiting
  const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  
  // Check rate limit
  if (!checkRateLimit(ip as string)) {
    return res.status(429).json({ 
      error: "Rate limit exceeded. Please try again later.",
      retryAfter: "1 hour" 
    });
  }
  
  const { prompt } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  
  // Validate prompt length
  if (prompt.length > 10000) {
    return res.status(400).json({ 
      error: "Prompt too long. Maximum 10,000 characters." 
    });
  }
  
  const model = chooseModel(prompt);
  const startTime = Date.now();
  
  try {
    if (model === "claude") {
      // Timeout at 8 seconds (leaving 2 seconds buffer for Vercel's 10s limit)
      const message = await withTimeout(
        anthropic.messages.create({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 8000,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        }),
        8000
      );
      
      const duration = Date.now() - startTime;
      console.log(`[SUCCESS] Claude request completed in ${duration}ms`);
      
      return res.json({
        text: message.content[0].text,
        model: "claude",
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          duration: duration
        }
      });
    } else {
      // Timeout at 8 seconds
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 4000
        }),
        8000
      );
      
      const duration = Date.now() - startTime;
      console.log(`[SUCCESS] OpenAI request completed in ${duration}ms`);
      
      return res.json({
        text: completion.choices[0].message.content,
        model: "openai",
        usage: {
          inputTokens: completion.usage?.prompt_tokens,
          outputTokens: completion.usage?.completion_tokens,
          duration: duration
        }
      });
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    // Handle timeout errors
    if (error.message === "Request timeout") {
      console.error(`[TIMEOUT] Request exceeded 8 seconds`);
      return res.status(408).json({ 
        error: "Request timeout. The AI is taking too long to respond. Please try a shorter prompt." 
      });
    }
    
    // Handle rate limit errors from AI providers
    if (error.status === 429 || error.code === "rate_limit_exceeded") {
      console.error(`[RATE_LIMIT] AI provider rate limit hit`);
      return res.status(429).json({ 
        error: "AI service rate limit reached. Please try again in a few moments." 
      });
    }
    
    console.error(`[ERROR] ${model} request failed after ${duration}ms:`, error);
    return res.status(500).json({ 
      error: "Failed to generate response. Please try again.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
}
