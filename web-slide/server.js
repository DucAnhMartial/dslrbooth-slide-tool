const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const DEBUG_REQUEST_LOG = path.join(__dirname, 'webhook-json.log');
console.log('STARTUP: server.js loaded from', __filename);
console.log('STARTUP: __dirname=', __dirname, 'cwd=', process.cwd());
console.log('STARTUP: logging webhook JSON to', DEBUG_REQUEST_LOG);

// Port 3001 is NAT'd to the public internet so the room screen can be watched
// remotely. Watching is a GET; nothing a stranger sends should CHANGE what is
// on that screen. CORS is therefore allowed for reads only — a blanket
// app.use(cors()) additionally handed any web page on the internet permission
// to read cross-origin responses from the mutating routes below.
app.use(cors({ methods: ['GET', 'HEAD', 'OPTIONS'] }));

// Trusted writers, by source address. The Extension Service posts photos from
// localhost (NOTIFY_WEBHOOK_URL=http://localhost:3001/webhook/json) and the
// operator sits on the venue LAN, so both keep working; the public internet
// does not. Same allow-list shape as the Extension Service's own AUTH-02 gate
// on /on-register, deliberately — one idea, expressed the same way twice.
//
// Set WEBHOOK_ALLOW_ALL=1 to disable this if a future writer lives off-LAN.
// That is an escape hatch for an emergency, not a configuration to leave on.
const TRUSTED_PREFIXES = ['127.', '::1', '::ffff:127.', '10.', '192.168.', '172.16.', '172.17.',
  '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
  '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

function isTrusted(addr) {
  if (!addr) return false;
  const bare = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return TRUSTED_PREFIXES.some(p => addr.startsWith(p) || bare.startsWith(p));
}

function trustedOnly(req, res, next) {
  if (process.env.WEBHOOK_ALLOW_ALL === '1') return next();
  const addr = req.socket.remoteAddress;
  if (isTrusted(addr)) return next();
  console.warn(`REJECTED ${req.method} ${req.path} from untrusted ${addr}`);
  return res.status(403).json({ success: false, error: 'forbidden' });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(__dirname));

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

app.get('/_status', (req, res) => {
  res.json({
    status: 'ok',
    serverFile: __filename,
    cwd: process.cwd(),
    dirname: __dirname,
  });
});

// ./uploads is served by express.static above, so whatever lands there is
// fetched from the room screen's own origin. An arbitrary extension therefore
// meant an arbitrary document on that origin — `.html` or `.svg` carrying a
// script, not merely a mis-named photo. Path traversal out of ./uploads was
// never reachable (the `<timestamp>-b64.` prefix forces any `..` to sit behind
// a directory that does not exist), so this list is about what the file IS,
// not about where it goes.
const ALLOWED_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

function safeExt(raw, fallback = 'jpg') {
  const ext = String(raw || '').replace(/^image\//, '').replace(/^\./, '').toLowerCase();
  return ALLOWED_IMAGE_EXT.has(ext) ? ext : fallback;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${unique}.${safeExt(path.extname(file.originalname))}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const customers = [];
const MAX = 50;
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'init', customers })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/webhook', trustedOnly, upload.single('image'), (req, res) => {
  try {
    const body = req.body;
    const file = req.file;
    const customer = {
      id: body.jobId || Date.now(),
      jobId: body.jobId || null,
      name: body.guestName || body.name || body.customer_name || 'Khách hàng',
      phone: body.phone || body.customer_phone || '',
      email: body.email || body.customer_email || '',
      note: body.note || body.message || (body.mode ? `Mode: ${body.mode}` : ''),
      receivedAt: body.timestamp || new Date().toISOString(),
      imageUrl: file ? `/uploads/${file.filename}` : (body.photoUrl || body.imageUrl || body.image_url || null),
      mode: body.mode || null,
      imageBase64: null,
    };
    if (!customer.imageUrl && body.image_base64) {
      const base64Data = body.image_base64.replace(/^data:image\/\w+;base64,/, '');
      const ext = safeExt(body.image_type);
      const filename = `${Date.now()}-b64.${ext}`;
      fs.writeFileSync(`./uploads/${filename}`, Buffer.from(base64Data, 'base64'));
      customer.imageUrl = `/uploads/${filename}`;
    }
    customers.unshift(customer);
    if (customers.length > MAX) customers.pop();
    broadcast({ type: 'new_customer', customer });
    res.status(200).json({ success: true, id: customer.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhook/json', trustedOnly, (req, res) => {
  try {
    const body = req.body;
    const requestLog = `TIME=${new Date().toISOString()} BODY=${JSON.stringify(body)}\n`;
    fs.appendFileSync(DEBUG_REQUEST_LOG, requestLog);
    console.log('DEBUG webhook/json body=', JSON.stringify(body));

    const customer = {
      id: body.jobId || Date.now(),
      jobId: body.jobId || null,
      name: body.guestName || body.name || body.customer_name || 'Khách hàng',
      phone: body.phone || body.customer_phone || '',
      email: body.email || body.customer_email || '',
      note: body.note || body.message || (body.mode ? `Mode: ${body.mode}` : ''),
      receivedAt: body.timestamp || new Date().toISOString(),
      imageUrl: body.photoUrl || body.imageUrl || body.image_url || null,
      mode: body.mode || null,
    };

    if (!customer.imageUrl && body.image_base64) {
      const base64Data = body.image_base64.replace(/^data:image\/\w+;base64,/, '');
      const ext = safeExt(body.image_type);
      const filename = `${Date.now()}-b64.${ext}`;
      fs.writeFileSync(`./uploads/${filename}`, Buffer.from(base64Data, 'base64'));
      customer.imageUrl = `/uploads/${filename}`;
    }

    customers.unshift(customer);
    if (customers.length > MAX) customers.pop();

    console.log('NEW CUSTOMER JSON:', JSON.stringify(customer));
    fs.appendFileSync(DEBUG_REQUEST_LOG, `RESULT=${JSON.stringify(customer)}\n`);
    broadcast({ type: 'new_customer', customer });

    res.status(200).json({
      success: true,
      id: customer.id,
      receivedBody: body,
      mappedCustomer: customer,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/customers', (req, res) => res.json(customers));

app.delete('/api/customers', trustedOnly, (req, res) => {
  customers.length = 0;
  broadcast({ type: 'clear' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Server chạy tại: http://localhost:${PORT}`);
  console.log(`📡 Webhook endpoint:`);
  console.log(`   POST http://localhost:${PORT}/webhook       (multipart/form-data)`);
  console.log(`   POST http://localhost:${PORT}/webhook/json  (application/json)`);
  console.log(`🖥️  Slideshow:  http://localhost:${PORT}\n`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Stop the running service and restart this server.`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
