require('dotenv').config();
const { OpenAI } = require('openai');
const WebSocket = require('ws');
const express = require('express');
const { DateTime } = require('luxon');
const Retell = require('retell-sdk');

console.log('🔐 Loaded ENV - OPENAI_API_KEY:', process.env.OPENAI_API_KEY?.slice(0, 6));

const app = express();
const port = process.env.PORT || 3000;

if (!port) {
  console.error('PORT environment variable not set');
  process.exit(1);
}

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocket.Server({ server });
const activeConnections = new Map();

const retellClient = new Retell({ apiKey: process.env.RETELL_API_KEY });

function getGreeting() {
  const hour = DateTime.now().setZone('America/Mexico_City').hour;
  if (hour < 12) return "Good Morning, Todd!";
  if (hour < 17) return "Good Afternoon, Todd!";
  return "Good Evening, Todd!";
}

const agentPrompt = "As Todd's voice assistant, manage daily life and business. Be concise, friendly, proactive.";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class DemoLlmClient {
  constructor() {
    this.lastResponseId = 0;
  }

  async BeginMessage(ws) {
    const greeting = getGreeting();
    const res = {
      response_type: 'agent_interrupt',
      interrupt_id: this.lastResponseId++,
      content: greeting,
      content_complete: true,
      no_interruption_allowed: true,
      end_call: false,
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(res));
      console.log(`Sent BeginMessage at: ${DateTime.now().setZone('America/Mexico_City').toISO()}, content: ${greeting}`);
    }
  }

  ConversationToChatRequestMessages(conversation) {
    if (!conversation) return [];
    return conversation.map(turn => ({
      role: turn.role === 'agent' ? 'assistant' : 'user',
      content: turn.content,
    }));
  }

  sendPingPong(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping_pong', timestamp: Date.now() }));
      console.log(`Sent ping_pong at: ${DateTime.now().setZone('America/Mexico_City').toISO()}`);
    }
  }

  async DraftResponse(request, ws) {
    if (request.interaction_type === 'call_details' || request.interaction_type === 'update_only') {
      console.log(`${request.interaction_type} at ${DateTime.now().setZone('America/Mexico_City').toISO()}:`, request);
      return;
    }

    const requestMessages = this.ConversationToChatRequestMessages(request.transcript);
    requestMessages.unshift({
      role: 'system',
      content: `You are Todd's voice AI assistant, like ChatGPT Voice. Be concise (under 10 words), friendly, and proactive. Use casual language, occasional fillers (e.g., 'um', hey). Guess intent for ASR errors, say 'huh?' or 'static?' if unclear. End with questions or suggestions. Role: ${agentPrompt}`,
    });
    if (request.interaction_type === 'reminder_required') {
      requestMessages.push({ role: 'user', content: '(User silent, nudge them:)' });
    }

    const options = {
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 100,
      stream: true,
      frequency_penalty: 0.5,
    };

    try {
      const stream = await openai.chat.completions.create({ messages: requestMessages, ...options });

      let fullContent = '';
      for await (const chunk of stream) {
        if (chunk.choices?.[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          fullContent += content;
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          response_type: 'response',
          response_id: request.response_id,
          content: fullContent,
          content_complete: true,
          end_call: false,
        }));
        console.log(`Sent LLM response at: ${DateTime.now().setZone('America/Mexico_City').toISO()}, content: ${fullContent}`);
      }
    } catch (err) {
      console.error(`LLM error at: ${DateTime.now().setZone('America/Mexico_City').toISO()}`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          response_type: 'response',
          response_id: request.response_id,
          content: 'Static? Something broke, Todd!',
          content_complete: true,
          end_call: false,
        }));
      }
    }
  }

  sendKeepAlive(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keep_alive', timestamp: Date.now() }));
      console.log(`Sent keep_alive at: ${DateTime.now().setZone('America/Mexico_City').toISO()}`);
    }
  }
}

const llmClient = new DemoLlmClient();

wss.on('connection', (ws, req) => {
  const callId = req.url.split('/').pop();
  console.log(`WebSocket connection attempt for call_id: ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}`);

  if (activeConnections.has(callId)) {
    console.warn(`Duplicate connection for ${callId}, closing new connection`);
    ws.close(1008, 'Duplicate connection detected');
    return;
  }
  activeConnections.set(callId, ws);

  ws.send(JSON.stringify({
    response_type: 'config',
    config: {
      auto_reconnect: true,
      call_details: true,
    },
  }));
  console.log(`Sent config at: ${DateTime.now().setZone('America/Mexico_City').toISO()}`);

  llmClient.BeginMessage(ws);

  const pingInterval = setInterval(() => llmClient.sendPingPong(ws), 5000);
  const keepAliveInterval = setInterval(() => llmClient.sendKeepAlive(ws), 10000);

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      console.error(`Binary message for ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}, length: ${message.length}`);
      return;
    }

    try {
      const request = JSON.parse(message.toString());
      console.log(`Received for ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}:`, request);
      if (request.interaction_type === 'ping_pong') {
        llmClient.sendPingPong(ws);
      } else {
        llmClient.DraftResponse(request, ws);
      }
    } catch (err) {
      console.error(`Parse error for ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}:`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          response_type: 'response',
          response_id: 0,
          content: 'Static? Try again, Todd!',
          content_complete: true,
          end_call: false,
        }));
        ws.close(1002, 'Cannot parse incoming message');
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed for ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}: code=${code}, reason=${reason.toString()}`);
    activeConnections.delete(callId);
    clearInterval(pingInterval);
    clearInterval(keepAliveInterval);
    if (code === 1000) {
      console.warn(`Retell server closed connection for ${callId}, possible inactivity or API issue`);
    } else if (code === 1008) {
      console.warn(`Duplicate connection detected for ${callId}, client should request new callId`);
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${callId} at ${DateTime.now().setZone('America/Mexico_City').toISO()}:`, err.message);
  });
});

app.get('/', (req, res) => res.send('LLM WebSocket Server Running'));

setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`Memory usage at ${DateTime.now().setZone('America/Mexico_City').toISO()}: RSS=${(memory.rss / 1024 / 1024).toFixed(2)}MB, Heap=${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
}, 60000);
