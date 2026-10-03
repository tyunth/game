const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT,
        class_name TEXT,
        streak INTEGER DEFAULT 0,
        last_played_date TEXT,
        achievements TEXT DEFAULT '[]'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        topic_id TEXT,
        date TEXT,
        medal TEXT,
        score INTEGER,
        hints_used INTEGER DEFAULT 0,
        FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    // Новая таблица для аналитики
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        action TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

const getTodayDate = () => new Date().toISOString().split('T')[0];
const getYesterdayDate = () => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
};

// --- API РОУТЫ ---
app.get('/api/students', (req, res) => {
    db.all("SELECT id, name, class_name FROM students ORDER BY class_name, name", [], (err, rows) => {
        res.json(rows);
    });
});

// НОВЫЙ РОУТ ДЛЯ ПРОГРЕССА
app.get('/api/student-progress/:id', (req, res) => {
    const studentId = req.params.id;
    const today = getTodayDate();

    db.get("SELECT streak, achievements FROM students WHERE id = ?", [studentId], (err, student) => {
        if (err || !student) return res.status(404).json({ error: 'Ученик не найден' });

        db.all("SELECT topic_id, medal FROM sessions WHERE student_id = ? AND date = ?", [studentId, today], (err, sessions) => {
            res.json({
                streak: student.streak,
                achievements: JSON.parse(student.achievements || '[]'),
                todayTopics: sessions.map(s => ({ topic: s.topic_id, medal: s.medal }))
            });
        });
    });
});

app.post('/api/save-result', (req, res) => {
    const { studentId, topicId, medal, score, hintsUsed } = req.body;
    const today = getTodayDate();
    const yesterday = getYesterdayDate();

    db.get("SELECT streak, last_played_date, achievements FROM students WHERE id = ?", [studentId], (err, student) => {
        if (err || !student) return res.status(404).json({ error: 'Ученик не найден' });

        let newStreak = student.streak;
        if (student.last_played_date !== today) {
            newStreak = (student.last_played_date === yesterday) ? student.streak + 1 : 1;
        }

        let achs = JSON.parse(student.achievements || '[]');
        let newlyUnlocked = [];

        if (medal === 'gold' && !achs.includes('first_gold')) { achs.push('first_gold'); newlyUnlocked.push('🥇 Первое золото'); }
        if (medal === 'gold' && hintsUsed === 0 && !achs.includes('flawless')) { achs.push('flawless'); newlyUnlocked.push('🧠 Идеальный разум'); }
        if (newStreak >= 3 && !achs.includes('streak_3')) { achs.push('streak_3'); newlyUnlocked.push('🔥 В ударе (3 дня)'); }

        db.run("UPDATE students SET streak = ?, last_played_date = ?, achievements = ? WHERE id = ?", 
            [newStreak, today, JSON.stringify(achs), studentId], () => {
            db.run("INSERT INTO sessions (student_id, topic_id, date, medal, score, hints_used) VALUES (?, ?, ?, ?, ?, ?)", 
                [studentId, topicId, today, medal, score, hintsUsed || 0], () => {
                res.json({ success: true, newStreak, newAchievements: newlyUnlocked });
            });
        });
    });
});

// Роут для приема логов
app.post('/api/log', (req, res) => {
    const { studentId, action, details } = req.body;
    if (!studentId) return res.status(400).send('No student');
    db.run("INSERT INTO logs (student_id, action, details) VALUES (?, ?, ?)", 
        [studentId, action, JSON.stringify(details)], (err) => {
        res.sendStatus(200);
    });
});


// --- АДМИНКА ---
const adminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).setHeader('WWW-Authenticate', 'Basic').send('');
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === 'teacher' && auth[1] === 'math123') next();
    else res.status(401).setHeader('WWW-Authenticate', 'Basic').send('');
};

app.post('/admin/add-student', adminAuth, (req, res) => {
    const { student_id, student_name, class_name } = req.body;
    if (student_id && student_name && class_name) {
        db.run("INSERT OR IGNORE INTO students (id, name, class_name) VALUES (?, ?, ?)", 
            [student_id, student_name, class_name]);
    }
    res.redirect('/admin');
});

app.get('/admin', adminAuth, (req, res) => {
    const query = `
        SELECT s.id, s.name, s.class_name, s.streak, s.last_played_date, 
            COUNT(sess.id) as total_games,
            SUM(sess.hints_used) as total_hints,
            SUM(CASE WHEN sess.medal = 'gold' THEN 1 ELSE 0 END) as total_gold
        FROM students s
        LEFT JOIN sessions sess ON s.id = sess.student_id
        GROUP BY s.id ORDER BY s.class_name, s.name
    `;

    db.all(query, [], (err, rows) => {
        let html = `
            <meta charset="UTF-8">
            <style>body{font-family:sans-serif; padding:20px;} table{border-collapse:collapse; width:100%;} th,td{border:1px solid #ddd; padding:8px; text-align:center;} th{background:#f4f7f9;} .form-box{background:#eee; padding:15px; margin-bottom:20px; border-radius:8px;}</style>
            <h2>Панель учителя</h2>
            <div class="form-box">
                <form action="/admin/add-student" method="POST" style="display:flex; gap:10px;">
                    <input type="text" name="student_id" placeholder="Логин (a1)" required>
                    <input type="text" name="student_name" placeholder="Фамилия Имя" required>
                    <select name="class_name">
                        <option value="5 А">5 А</option>
                        <option value="5 Б">5 Б</option>
                        <option value="5 В">5 В</option>
                    </select>
                    <button type="submit">+ Добавить ученика</button>
                </form>
            </div>
            <table>
                <tr><th>Класс</th><th>Ученик</th><th>Стрик</th><th>Золото</th><th>Игр</th><th>Логи</th></tr>
        `;
        rows.forEach(r => {
            html += `<tr><td>${r.class_name || '-'}</td><td style="text-align:left;">${r.name}</td><td>${r.streak}</td><td>${r.total_gold}</td><td>${r.total_games}</td>
            <td><a href="/admin/logs/${r.id}">Смотреть</a></td></tr>`;
        });
        res.send(html + `</table>`);
    });
});

app.get('/admin/logs/:studentId', adminAuth, (req, res) => {
    db.all("SELECT * FROM logs WHERE student_id = ? ORDER BY created_at DESC LIMIT 50", [req.params.studentId], (err, rows) => {
        let html = `<meta charset="UTF-8"><style>body{font-family:sans-serif;}</style><h2>Последние 50 действий (Ученик: ${req.params.studentId})</h2><a href="/admin">← Назад</a><br><br><table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;"><tr><th>Время</th><th>Действие</th><th>Детали</th></tr>`;
        rows.forEach(r => {
            html += `<tr><td>${new Date(r.created_at).toLocaleString('ru-RU')}</td><td>${r.action}</td><td>${r.details}</td></tr>`;
        });
        res.send(html + `</table>`);
    });
});

app.listen(PORT, () => console.log('Сервер: http://localhost:' + PORT));
