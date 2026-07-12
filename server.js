const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'data', 'db.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

function readDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) { console.error('Lỗi đọc DB:', e); }
    return {
        users: {
            'lichcuto': {
                password: 'tinkm2009',
                email: 'admin@evokey.com',
                balance: 0,
                keys: [],
                isAdmin: true,
                created: new Date().toISOString()
            }
        },
        transactions: { pending: [], all: [] }
    };
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// API routes...
app.post('/api/auth', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    if (!username || !password) {
        return res.json({ success: false, message: 'Vui lòng điền đầy đủ thông tin.' });
    }
    if (username === 'lichcuto' && password === 'tinkm2009') {
        return res.json({
            success: true,
            user: { username: 'lichcuto', isAdmin: true, balance: 0, keys: [] }
        });
    }
    const user = db.users[username];
    if (!user || user.password !== password) {
        return res.json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu.' });
    }
    res.json({
        success: true,
        user: {
            username: username,
            isAdmin: false,
            balance: user.balance || 0,
            keys: user.keys || []
        }
    });
});

app.post('/api/register', (req, res) => {
    const { username, password, email } = req.body;
    const db = readDB();
    if (!username || !password || !email) {
        return res.json({ success: false, message: 'Vui lòng điền đầy đủ thông tin.' });
    }
    if (username === 'lichcuto' || db.users[username]) {
        return res.json({ success: false, message: 'Tên đăng nhập đã tồn tại.' });
    }
    db.users[username] = {
        password: password,
        email: email,
        balance: 0,
        keys: [],
        isAdmin: false,
        created: new Date().toISOString()
    };
    writeDB(db);
    res.json({ success: true, message: 'Đăng ký thành công!' });
});

app.get('/api/admin/users', (req, res) => {
    const db = readDB();
    const users = Object.keys(db.users).filter(u => u !== 'lichcuto');
    res.json({ users: users });
});

app.post('/api/admin/create-key', (req, res) => {
    const { adminUser, targetUser, pkg } = req.body;
    if (adminUser !== 'lichcuto') {
        return res.json({ success: false, message: 'Không có quyền.' });
    }
    const db = readDB();
    const user = db.users[targetUser];
    if (!user) {
        return res.json({ success: false, message: 'User không tồn tại.' });
    }
    const PKGS = {
        daily: { name: 'Daily', days: 1 },
        weekly: { name: 'Weekly', days: 7 },
        monthly: { name: 'Monthly', days: 30 },
        yearly: { name: 'Yearly', days: 365 }
    };
    const pkgInfo = PKGS[pkg];
    if (!pkgInfo) {
        return res.json({ success: false, message: 'Gói không hợp lệ.' });
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
        if (i === 3 || i === 7 || i === 11) key += '-';
    }
    const now = Date.now();
    const expiry = new Date(now + pkgInfo.days * 86400000);
    if (!user.keys) user.keys = [];
    user.keys.push({
        key: key,
        start: new Date(now).toISOString(),
        expiry: expiry.toISOString(),
        pkg: pkg
    });
    db.users[targetUser] = user;
    db.transactions.all.push({
        user: targetUser,
        type: 'admin_create',
        pkg: pkg,
        key: key,
        time: new Date().toISOString(),
        admin: 'lichcuto'
    });
    writeDB(db);
    res.json({
        success: true,
        message: `Đã tạo key ${pkg} cho ${targetUser}`,
        key: key,
        expiry: expiry.toISOString()
    });
});

app.post('/api/purchase', (req, res) => {
    const { username, pkg } = req.body;
    const db = readDB();
    const user = db.users[username];
    if (!user) {
        return res.json({ success: false, message: 'User không tồn tại.' });
    }
    const PKGS = {
        daily: { name: 'Daily', price: 2500, days: 1 },
        weekly: { name: 'Weekly', price: 12000, days: 7 },
        monthly: { name: 'Monthly', price: 50000, days: 30 },
        yearly: { name: 'Yearly', price: 150000, days: 365 }
    };
    const pkgInfo = PKGS[pkg];
    if (!pkgInfo) {
        return res.json({ success: false, message: 'Gói không hợp lệ.' });
    }
    if (user.balance < pkgInfo.price) {
        return res.json({ success: false, message: `Số dư không đủ. Cần ${pkgInfo.price} VNĐ.` });
    }
    user.balance -= pkgInfo.price;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 16; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
        if (i === 3 || i === 7 || i === 11) key += '-';
    }
    const now = Date.now();
    const expiry = new Date(now + pkgInfo.days * 86400000);
    if (!user.keys) user.keys = [];
    user.keys.push({
        key: key,
        start: new Date(now).toISOString(),
        expiry: expiry.toISOString(),
        pkg: pkg
    });
    db.users[username] = user;
    db.transactions.all.push({
        user: username,
        type: 'purchase',
        pkg: pkg,
        amount: pkgInfo.price,
        key: key,
        time: new Date().toISOString()
    });
    writeDB(db);
    res.json({
        success: true,
        message: `Mua ${pkgInfo.name} thành công!`,
        key: key,
        expiry: expiry.toISOString(),
        balance: user.balance
    });
});

app.post('/api/deposit', (req, res) => {
    const { username, method, amount, serial, pin } = req.body;
    const db = readDB();
    const user = db.users[username];
    if (!user) {
        return res.json({ success: false, message: 'User không tồn tại.' });
    }
    if (method === 'card') {
        if (!serial || !pin || serial.length < 10 || pin.length < 6) {
            return res.json({ success: false, message: 'Thẻ không hợp lệ. Vui lòng kiểm tra lại.' });
        }
        if (Math.random() > 0.9) {
            return res.json({ success: false, message: 'Thẻ đã được sử dụng hoặc không hợp lệ.' });
        }
    }
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    db.transactions.pending.push({
        id: id,
        user: username,
        type: 'deposit',
        method: method,
        amount: amount,
        time: new Date().toISOString(),
        status: 'pending',
        serial: serial || '',
        pin: pin || ''
    });
    writeDB(db);
    res.json({
        success: true,
        message: 'Đã tạo yêu cầu nạp. Vui lòng chờ admin xác nhận.'
    });
});

app.post('/api/admin/approve-deposit', (req, res) => {
    const { adminUser, depositId } = req.body;
    if (adminUser !== 'lichcuto') {
        return res.json({ success: false, message: 'Không có quyền.' });
    }
    const db = readDB();
    const idx = db.transactions.pending.findIndex(t => t.id === depositId && t.status === 'pending');
    if (idx === -1) {
        return res.json({ success: false, message: 'Giao dịch không tồn tại.' });
    }
    const t = db.transactions.pending[idx];
    const user = db.users[t.user];
    if (!user) {
        return res.json({ success: false, message: 'User không tồn tại.' });
    }
    user.balance = (user.balance || 0) + t.amount;
    db.users[t.user] = user;
    db.transactions.all.push({
        user: t.user,
        type: 'deposit',
        method: t.method,
        amount: t.amount,
        time: t.time,
        status: 'approved'
    });
    db.transactions.pending.splice(idx, 1);
    writeDB(db);
    res.json({
        success: true,
        message: `Đã duyệt nạp ${t.amount} VNĐ cho ${t.user}.`
    });
});

app.post('/api/admin/reject-deposit', (req, res) => {
    const { adminUser, depositId } = req.body;
    if (adminUser !== 'lichcuto') {
        return res.json({ success: false, message: 'Không có quyền.' });
    }
    const db = readDB();
    const idx = db.transactions.pending.findIndex(t => t.id === depositId && t.status === 'pending');
    if (idx === -1) {
        return res.json({ success: false, message: 'Giao dịch không tồn tại.' });
    }
    const t = db.transactions.pending[idx];
    db.transactions.all.push({
        user: t.user,
        type: 'deposit',
        method: t.method,
        amount: t.amount,
        time: t.time,
        status: 'rejected'
    });
    db.transactions.pending.splice(idx, 1);
    writeDB(db);
    res.json({
        success: true,
        message: `Đã từ chối nạp của ${t.user}.`
    });
});

app.post('/api/user-data', (req, res) => {
    const { username } = req.body;
    const db = readDB();
    if (username === 'lichcuto') {
        const pending = db.transactions.pending.filter(t => t.status === 'pending');
        return res.json({
            success: true,
            isAdmin: true,
            balance: 0,
            keys: [],
            pending: pending,
            history: db.transactions.all.filter(t => t.type === 'deposit')
        });
    }
    const user = db.users[username];
    if (!user) {
        return res.json({ success: false, message: 'User không tồn tại.' });
    }
    const history = db.transactions.all.filter(t => t.user === username);
    res.json({
        success: true,
        isAdmin: false,
        balance: user.balance || 0,
        keys: user.keys || [],
        history: history
    });
});

app.get('/api/admin/pending', (req, res) => {
    const db = readDB();
    res.json({ pending: db.transactions.pending.filter(t => t.status === 'pending') });
});

app.listen(PORT, () => {
    console.log(`🚀 Server chạy tại: http://localhost:${PORT}`);
    console.log(`🔑 Admin: lichcuto / tinkm2009`);
});