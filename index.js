const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

// 1. WhatsApp Client Setup
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
    }
});

// QR Code generation
client.on('qr', (qr) => {
    console.log('--- SCAN THIS QR CODE ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Client is Ready and Connected!');
});

// 2. Self-Ping Mechanism (To prevent Render from sleeping)
setInterval(async () => {
    try {
        console.log(`Pinging server at ${SERVER_URL}/health...`);
        await axios.get(`${SERVER_URL}/health`);
    } catch (err) {
        console.error("Self-ping failed:", err.message);
    }
}, 600000); // Protite 10 minute por por ping korbe

// 3. API Endpoints
app.get('/health', (req, res) => {
    res.status(200).send('Server is Up and Running!');
});

app.get('/', (req, res) => {
    res.send('WhatsApp Bridge is Active. Check logs for QR code.');
});

// Start Server & Client
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`External URL: ${SERVER_URL}`);
    client.initialize();
});