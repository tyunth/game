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
    // Добавлено поле achievements (JSON строка)
    db.run(`CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT,
        streak INTEGER DEFAULT 0,
        last_played_date TEXT,
        achievements TEXT DEFAULT '[]'
    )`);

    // Добавлено поле hints_used
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

    db.get("SELECT COUNT(*) as count FROM students", (err, row) => {
        if (row.count === 0) {
            const insert = db.prepare("INSERT INTO students (id, name) VALUES (?, ?)");
            insert.run('ivanov', 'Иванов Иван');
            insert.run('petrov', 'Петров Петр');
            insert.run('sidorova', 'Сидорова Анна');
            insert.finalize();
        }
    });
});

const getTodayDate = () => new Date().toISOString().split('T')[0];
const getYesterdayDate = () => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
};

app.get('/api/students', (req, res) => {
    db.all("SELECT id, name FROM students ORDER BY name", [], (err, rows) => {
        res.json(rows);
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

        // --- ЛОГИКА АЧИВОК ---
        let achs = JSON.parse(student.achievements || '[]');
        let newlyUnlocked = [];

        if (medal === 'gold' && !achs.includes('first_gold')) {
            achs.push('first_gold'); newlyUnlocked.push('🥇 Первое золото');
        }
        if (medal === 'gold' && hintsUsed === 0 && !achs.includes('flawless')) {
            achs.push('flawless'); newlyUnlocked.push('🧠 Идеальный разум (Без подсказок)');
        }
        if (newStreak >= 3 && !achs.includes('streak_3')) {
            achs.push('streak_3'); newlyUnlocked.push('🔥 В ударе (3 дня подряд)');
        }

        // Сохраняем ученика
        db.run("UPDATE students SET streak = ?, last_played_date = ?, achievements = ? WHERE id = ?", 
            [newStreak, today, JSON.stringify(achs), studentId], () => {
            
            // Сохраняем сессию (вместе с подсказками)
            db.run("INSERT INTO sessions (student_id, topic_id, date, medal, score, hints_used) VALUES (?, ?, ?, ?, ?, ?)", 
                [studentId, topicId, today, medal, score, hintsUsed || 0], () => {
                
                res.json({ success: true, newStreak, newAchievements: newlyUnlocked });
            });
        });
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

app.get('/admin', adminAuth, (req, res) => {
    const query = `
        SELECT 
            s.name, s.streak, s.last_played_date, 
            COUNT(sess.id) as total_games,
            SUM(sess.hints_used) as total_hints,
            SUM(CASE WHEN sess.medal = 'gold' THEN 1 ELSE 0 END) as total_gold
        FROM students s
        LEFT JOIN sessions sess ON s.id = sess.student_id
        GROUP BY s.id ORDER BY s.name
    `;

    db.all(query, [], (err, rows) => {
        let html = `
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <h2 style="font-family: sans-serif;">Панель учителя (5 Класс)</h2>
            <table border="1" cellpadding="10" style="border-collapse: collapse; font-family: sans-serif; text-align: center;">
                <tr style="background: #f4f7f9;">
                    <th>Ученик</th><th>Стрик 🔥</th><th>Золота 🥇</th><th>Всего игр</th><th>Взято подсказок 👀</th><th>Последний заход</th>
                </tr>
        `;
        rows.forEach(r => {
            html += `<tr><td style="text-align: left;">${r.name}</td><td>${r.streak}</td><td>${r.total_gold}</td><td>${r.total_games}</td><td><b>${r.total_hints || 0}</b></td><td>${r.last_played_date || '-'}</td></tr>`;
        });
        res.send(html + `</table>`);
    });
});

app.post('/admin/add-student', adminAuth, (req, res) => {
    const { student_id, student_name } = req.body;
    
    if (!student_id || !student_name) return res.redirect('/admin');

    // INSERT OR IGNORE защитит от дублей, если случайно ввести один и тот же ID
    db.run("INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)", [student_id, student_name], (err) => {
        if (err) console.error(err);
        res.redirect('/admin'); // Перезагружаем страницу админки
    });
});

app.listen(PORT, () => console.log('Сервер: http://localhost:' + PORT));
