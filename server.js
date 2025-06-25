require('dotenv').config();
const express = require('express');
const Retell = require('retell-sdk');

const app = express();
const port = process.env.PORT || 3000;
const retellClient = new Retell({ apiKey: process.env.RETELL_API_KEY });

app.get('/', (req, res) => res.send('Retell Multi-Turn Agent Server Running'));

app.get('/create-call', async (req, res) => {
  try {
    const call = await retellClient.call.createWebCall({
      agent_id: 'agent_5aa20d278f2d19133966026033',
      version: 4, // ✅ Required for correct agent version
      call_type: 'web_call'
    });

    console.log("✅ Created Retell Web Call:", call.call_id);
    res.json({ call_id: call.call_id, access_token: call.access_token });
  } catch (err) {
    console.error('❌ Retell Web Call creation failed:', err.message);
    res.status(500).send('Failed to create Retell call');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});