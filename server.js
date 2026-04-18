const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: 'family-restaurant-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ===== File Upload =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ===== DB Helpers =====
const DB_PATH = path.join(__dirname, 'data', 'db.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { products: [], orders: [], tables: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ===== Auth Middleware =====
const ADMIN_EMAIL = 'jawadshahen11@gmail.com';
const ADMIN_PASSWORD = 'jawad12345';

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ===== SSE for real-time =====
let clients = [];

function sendSSE(data) {
  clients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  clients.push(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c !== res);
  });
});

// ===== PUBLIC ROUTES =====

// Get all products
app.get('/api/products', (req, res) => {
  const db = readDB();
  res.json(db.products);
});

// Get categories
app.get('/api/categories', (req, res) => {
  const db = readDB();
  const cats = [...new Set(db.products.map(p => p.category))];
  res.json(cats);
});

// Place order
app.post('/api/orders', (req, res) => {
  const db = readDB();
  const { items, customer, orderType, address, notes, table } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'لا توجد عناصر في الطلب' });
  }

  // Calculate total
  let subtotal = 0;
  const enrichedItems = items.map(item => {
    const product = db.products.find(p => p.id === item.id);
    if (!product) return null;
    const price = product.discount > 0 
      ? product.price * (1 - product.discount / 100) 
      : product.price;
    subtotal += price * item.quantity;
    return { ...product, quantity: item.quantity, unitPrice: price };
  }).filter(Boolean);

  const deliveryFee = orderType === 'delivery' ? 6 : 0;
  const total = subtotal + deliveryFee;

  const order = {
    id: uuidv4(),
    orderNumber: `#${Date.now().toString().slice(-6)}`,
    items: enrichedItems,
    customer,
    orderType,
    address: address || null,
    table: table || null,
    notes: notes || '',
    subtotal,
    deliveryFee,
    total,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.orders.push(order);
  writeDB(db);

  // Notify admin via SSE
  sendSSE({ type: 'new_order', order });

  res.json({ success: true, order });
});

// Get order status (for customer)
app.get('/api/orders/:id/status', (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ status: order.status, orderNumber: order.orderNumber });
});

// ===== ADMIN AUTH =====
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ===== ADMIN ROUTES =====

// Get all orders
app.get('/api/admin/orders', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Update order status
app.put('/api/admin/orders/:id', requireAuth, (req, res) => {
  const db = readDB();
  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'الطلب غير موجود' });

  db.orders[idx].status = req.body.status;
  db.orders[idx].updatedAt = new Date().toISOString();
  writeDB(db);

  sendSSE({ type: 'order_updated', order: db.orders[idx] });
  res.json({ success: true, order: db.orders[idx] });
});

// Get stats
app.get('/api/admin/stats', requireAuth, (req, res) => {
  const db = readDB();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const completed = db.orders.filter(o => o.status !== 'rejected');
  const todaySales = completed.filter(o => o.createdAt.startsWith(today))
    .reduce((s, o) => s + o.total, 0);
  const monthSales = completed.filter(o => o.createdAt.startsWith(thisMonth))
    .reduce((s, o) => s + o.total, 0);

  // Best seller
  const salesCount = {};
  completed.forEach(o => {
    o.items.forEach(item => {
      salesCount[item.name] = (salesCount[item.name] || 0) + item.quantity;
    });
  });
  const bestSeller = Object.entries(salesCount).sort((a, b) => b[1] - a[1])[0];

  res.json({
    todaySales,
    monthSales,
    totalOrders: db.orders.length,
    pendingOrders: db.orders.filter(o => o.status === 'pending').length,
    bestSeller: bestSeller ? { name: bestSeller[0], count: bestSeller[1] } : null
  });
});

// Products CRUD
app.post('/api/admin/products', requireAuth, upload.single('image'), (req, res) => {
  const db = readDB();
  const { name, description, price, category, available, discount } = req.body;
  const product = {
    id: uuidv4(),
    name,
    description,
    price: parseFloat(price),
    category,
    image: req.file ? `/uploads/${req.file.filename}` : '/images/default.jpg',
    available: available === 'true',
    discount: parseFloat(discount) || 0
  };
  db.products.push(product);
  writeDB(db);
  res.json({ success: true, product });
});

app.put('/api/admin/products/:id', requireAuth, upload.single('image'), (req, res) => {
  const db = readDB();
  const idx = db.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'المنتج غير موجود' });

  const { name, description, price, category, available, discount } = req.body;
  db.products[idx] = {
    ...db.products[idx],
    name: name || db.products[idx].name,
    description: description || db.products[idx].description,
    price: price ? parseFloat(price) : db.products[idx].price,
    category: category || db.products[idx].category,
    available: available !== undefined ? available === 'true' : db.products[idx].available,
    discount: discount !== undefined ? parseFloat(discount) : db.products[idx].discount,
    image: req.file ? `/uploads/${req.file.filename}` : db.products[idx].image
  };
  writeDB(db);
  res.json({ success: true, product: db.products[idx] });
});

app.delete('/api/admin/products/:id', requireAuth, (req, res) => {
  const db = readDB();
  db.products = db.products.filter(p => p.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// ===== SERVE PAGES =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/order-status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order-status.html'));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`🍽️  مطعم ومطبخ العائلة يعمل على: http://localhost:${PORT}`);
  console.log(`👨‍💼 لوحة التحكم: http://localhost:${PORT}/admin`);
});
