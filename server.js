// server.js (updated for full Retell + OpenAI + Function Calling support)
require('dotenv').config();
const { OpenAI } = require('openai');
const WebSocket = require('ws');
const express = require('express');
const { DateTime } = require('luxon');
const Retell = require('retell-sdk');

const app = express();
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocket.Server({ server });
const activeConnections = new Map();
const sessionConversations = new Map();
const retellClient = new Retell({ apiKey: process.env.RETELL_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getGreeting() {
  const hour = DateTime.now().setZone('America/Mexico_City').hour;
  if (hour < 12) return "Good Morning, Todd!";
  if (hour < 17) return "Good Afternoon, Todd!";
  return "Good Evening, Todd!";
}

const agentPrompt = "As Todd's voice assistant, manage daily life and business. Be concise, friendly, proactive.";

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
      console.log(`Sent BeginMessage: ${greeting}`);
    }
  }

  ConversationToChatRequestMessages(convo) {
    return convo.map(turn => ({
      role: turn.role === 'agent' ? 'assistant' : 'user',
      content: turn.content,
    }));
  }

  async DraftResponse(request, ws, sessionId) {
    if (request.interaction_type === 'call_details' || request.interaction_type === 'update_only') return;

    if (!sessionConversations.has(sessionId)) sessionConversations.set(sessionId, []);
    const conversation = sessionConversations.get(sessionId);

    const requestMessages = [
      {
        role: 'system',
        content: `You are Todd's voice AI assistant. ${agentPrompt}`
      },
      ...this.ConversationToChatRequestMessages(request.transcript || [])
    ];

    if (request.interaction_type === 'reminder_required') {
      requestMessages.push({ role: 'user', content: '(User silent, nudge them:)' });
    }

    const tools = [{
      type: "function",
      function: {
        name: "end_call",
        description: "End the call when user clearly indicates they are done.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Goodbye message to say before ending the call."
            }
          },
          required: ["message"]
        }
      }
    }];

    const stream = await openai.chat.completions.create({
      messages: requestMessages,
      model: 'gpt-4o',
      stream: true,
      tools,
      temperature: 0.7,
      max_tokens: 100
    });

    let funcCall = null;
    let funcArgs = '';
    let fullContent = '';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.tool_calls?.length) {
        const call = delta.tool_calls[0];
        if (call.id && call.function?.name === "end_call") {
          funcCall = { id: call.id, funcName: call.function.name, arguments: {} };
        } else if (call.function?.arguments) {
          funcArgs += call.function.arguments;
        }
      } else if (delta.content) {
        fullContent += delta.content;
        ws.send(JSON.stringify({
          response_type: 'response',
          response_id: request.response_id,
          content: delta.content,
          content_complete: false,
          end_call: false,
        }));
      }
    }

    if (funcCall && funcCall.funcName === 'end_call') {
      funcCall.arguments = JSON.parse(funcArgs);
      ws.send(JSON.stringify({
        response_type: 'response',
        response_id: request.response_id,
        content: funcCall.arguments.message,
        content_complete: true,
        end_call: true
      }));
    } else {
      ws.send(JSON.stringify({
        response_type: 'response',
        response_id: request.response_id,
        content: '',
        content_complete: true,
        end_call: false
      }));
      conversation.push({ role: 'user', content: request.transcript?.slice(-1)[0]?.content || '' });
      conversation.push({ role: 'agent', content: fullContent });
    }
  }

  sendPingPong(ws) {
    ws.send(JSON.stringify({ type: 'ping_pong', timestamp: Date.now() }));
  }

  sendKeepAlive(ws) {
    ws.send(JSON.stringify({ type: 'keep_alive', timestamp: Date.now() }));
  }
}

const llmClient = new DemoLlmClient();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callId = url.pathname.split('/').pop();
  const sessionId = url.searchParams.get('session_id') || callId;

  if (activeConnections.has(callId)) {
    ws.close(1008, 'Duplicate connection');
    return;
  }
  activeConnections.set(callId, ws);

  ws.send(JSON.stringify({ response_type: 'config', config: { auto_reconnect: true, call_details: true } }));

  setTimeout(() => llmClient.BeginMessage(ws), 4000);

  const pingInterval = setInterval(() => llmClient.sendPingPong(ws), 5000);
  const keepAliveInterval = setInterval(() => llmClient.sendKeepAlive(ws), 10000);

  ws.on('message', async (message, isBinary) => {
    if (isBinary) return;
    try {
      const request = JSON.parse(message.toString());
      if (request.interaction_type === 'ping_pong') {
        llmClient.sendPingPong(ws);
      } else {
        await llmClient.DraftResponse(request, ws, sessionId);
      }
    } catch (err) {
      ws.send(JSON.stringify({
        response_type: 'response',
        response_id: 0,
        content: 'Static? Try again, Todd!',
        content_complete: true,
        end_call: false
      }));
      ws.close(1002, 'Invalid JSON');
    }
  });

  ws.on('close', () => {
    activeConnections.delete(callId);
    clearInterval(pingInterval);
    clearInterval(keepAliveInterval);
  });
});

app.get('/', (req, res) => res.send('LLM WebSocket Server Running'));

app.get('/create-call', async (req, res) => {
  try {
    const call = await retellClient.webCall.create({ voice_id: '11labs-Adrian' });
    res.json({ call_id: call.call_id, access_token: call.access_token });
  } catch (err) {
    console.error('Retell Web Call creation failed:', err.message);
    res.status(500).send('Failed to create Retell call');
  }
});

setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`Memory usage: RSS=${(memory.rss / 1024 / 1024).toFixed(2)}MB, Heap=${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
}, 60000);