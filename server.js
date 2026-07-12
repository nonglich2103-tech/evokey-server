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
app.post('/api/verify-key', (req, res) => {
    const { key } = req.body;
    if (!key) {
        return res.json({ success: false, message: 'Vui lòng nhập Key.' });
    }

    const db = readDB();
    let foundKey = null;
    let foundUser = null;
    
    for (const [username, user] of Object.entries(db.users)) {
        if (user.keys) {
            const k = user.keys.find(k => k.key === key);
            if (k) {
                foundKey = k;
                foundUser = username;
                break;
            }
        }
    }

    if (!foundKey) {
        return res.json({ success: false, message: 'Key không hợp lệ.' });
    }

    if (foundKey.status === 'revoked') {
        return res.json({ success: false, message: 'Key đã bị vô hiệu hóa.' });
    }

    const expiry = new Date(foundKey.expiry);
    if (expiry < new Date()) {
        foundKey.status = 'expired';
        db.users[foundUser] = db.users[foundUser];
        writeDB(db);
        return res.json({ success: false, message: 'Key đã hết hạn.' });
    }

    // Trả về script (nếu có file, nếu không thì trả về thông báo)
    try {
        let scriptContent = '';
        try {
            scriptContent = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');
        } catch (err) {
            scriptContent = 'console.log("[EVOWARS] Script đã tải thành công!");';
        }
        res.json({
            success: true,
            message: 'Xác thực thành công!',
            script: scriptContent,
            user: foundUser,
            pkg: foundKey.pkg,
            expiry: foundKey.expiry
        });
    } catch (err) {
        res.json({ success: false, message: 'Lỗi tải script.' });
    }
});
