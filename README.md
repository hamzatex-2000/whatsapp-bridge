# HTTL WhatsApp Bridge Server

This is the external Node.js server that bridges your website's live chat with WhatsApp using `whatsapp-web.js`.

## Prerequisites

- **Node.js 18+** installed on your server
- **Chromium/Chrome** installed (required by Puppeteer for `whatsapp-web.js`)
- A **Supabase** project with the chat tables set up

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Environment Variables

Create a `.env` file or set these in your hosting environment:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
ADMIN_PHONE=8801718097927
PORT=3001
```

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase **service_role** key (keep secret!) |
| `ADMIN_PHONE` | Your WhatsApp phone number with country code (no `+`) |
| `PORT` | Server port (default: 3001) |

### 3. Start the Server

```bash
npm start
```

### 4. Connect WhatsApp

1. Go to your admin dashboard → **WhatsApp Chat** → **Connection** tab
2. Enter this server's URL in **Settings** tab (e.g., `https://your-server.com`)
3. Click **Connect WhatsApp**
4. Scan the QR code with your phone's WhatsApp → **Linked Devices** → **Link a Device**
5. Status should turn green ✅

## How It Works

```
Website Visitor → Sends message → Supabase → This server listens → Forwards to Admin WhatsApp
Admin → Replies on WhatsApp (quote the message) → This server parses → Saves to Supabase → Visitor sees reply
```

### Message Format on WhatsApp

When a visitor sends a message, the admin receives:

```
[Web Chat | ID: abc123-def456]
👤 John Doe
📱 01712345678

💬 I want to know about your services.
```

To reply, **long-press** the message → **Reply** → type your response. The server reads the quoted message to route the reply back to the correct visitor.

## Session Persistence

The server uses `LocalAuth` to persist the WhatsApp session in `.wwebjs_auth/`. This means:
- You won't need to scan the QR code again after server restarts
- If you want to log out, use the **Disconnect** button in the admin dashboard

## Deployment Options

### cPanel
1. Upload files to your server
2. Set up a Node.js app in cPanel
3. Set environment variables
4. Start the app

### Railway / Render
1. Push to a Git repo
2. Connect to Railway/Render
3. Set environment variables
4. Deploy

### VPS (Ubuntu)
```bash
# Install Chrome
sudo apt install -y chromium-browser

# Clone and install
git clone <your-repo>
cd whatsapp-server
npm install

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name httl-whatsapp
pm2 save
pm2 startup
```

## Troubleshooting

- **QR code not showing**: Make sure Chromium is installed and accessible
- **Puppeteer errors**: Try adding `PUPPETEER_SKIP_DOWNLOAD=true` and installing Chrome manually
- **Messages not forwarding**: Check that `ADMIN_PHONE` is correct (with country code, no +)
- **Session lost after restart**: Ensure `.wwebjs_auth/` folder is writable and persistent
