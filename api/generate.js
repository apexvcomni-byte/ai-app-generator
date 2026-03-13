const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Simple in-memory rate limiting (resets on deployment)
const requestCounts = new Map();

// Rate limiting: 20 requests per hour per IP
const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

function checkRateLimit(ip) {
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

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Rate limiting check
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
    if (!checkRateLimit(ip)) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Maximum 20 requests per hour.'
      });
    }

    // Validate request body
    const { prompt, model } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid request: prompt is required and must be a string'
      });
    }

    if (!model || !['gpt-4', 'claude-3.5-sonnet'].includes(model)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid model. Must be "gpt-4" or "claude-3.5-sonnet"'
      });
    }

    // Limit prompt length
    if (prompt.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'Prompt too long. Maximum 5000 characters.'
      });
    }

    let responseText;
    let usage;

    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 45000);
    });

    if (model === 'gpt-4') {
      // OpenAI GPT-4 request with timeout
      const apiPromise = openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });

      const completion = await Promise.race([apiPromise, timeoutPromise]);
      responseText = completion.choices[0].message.content;
      usage = {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens
      };
      
    } else if (model === 'claude-3.5-sonnet') {
      // Anthropic Claude request with timeout
      const apiPromise = anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      const message = await Promise.race([apiPromise, timeoutPromise]);
      responseText = message.content[0].text;
      usage = {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens
      };
    }

    // Log usage for monitoring
    console.log(`[${new Date().toISOString()}] ${model} - Tokens: ${usage.totalTokens}`);

    return res.status(200).json({
      success: true,
      text: responseText,
      model,
      usage
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    
    // Handle specific error types
    if (error.message === 'Request timeout') {
      return res.status(504).json({
        success: false,
        error: 'Request timed out. Please try with a shorter prompt.'
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        success: false,
        error: 'API rate limit exceeded. Please try again later.'
      });
    }

    if (error.status === 401) {
      return res.status(500).json({
        success: false,
        error: 'API authentication failed. Please contact support.'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.'
    });
  }
};
