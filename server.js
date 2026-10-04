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
    db.run(`CREATE TABLE IF NOT EXISTS topic_progress (
        student_id TEXT,
        topic_id TEXT,
        streak INTEGER DEFAULT 0,
        last_played_date TEXT,
        PRIMARY KEY (student_id, topic_id)
    )`);
    
});

const getTodayDate = () => new Date().toISOString().split('T')[0];
const getYesterdayDate = () => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
};

// Выполняет список асинхронных задач и вызывает done, когда все завершены
function runAsync(tasks, done) {
    let left = tasks.length;
    if (!left) return done();
    tasks.forEach(fn => fn(() => { if (--left === 0) done(); }));
};

// --- НЕДЕЛЯ И КОМАНДНЫЙ ЗАЧЁТ ---
const MIN_DAYS_FOR_SCORE = 5;  // столько дней нужно, чтобы попасть в зачёт
const TOPICS_COUNT = 3;        // количество доступных тем

// Понедельник текущей недели + сегодня
function getWeekInfo() {
    const today = getTodayDate();
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // 0 = понедельник
    const monday = new Date(now);
    monday.setDate(monday.getDate() - dow);
    return { monday, mondayStr: monday.toISOString().split('T')[0], today };
}

// --- ДОСТИЖЕНИЯ (единый справочник) ---
const ACHIEVEMENTS = {
    first_gold:    { icon: '🥇', title: 'Золотой старт',   desc: 'Получить первую золотую медаль.' },
    flawless:      { icon: '🛡️', title: 'Ни царапины',      desc: 'Золото без единой ошибки и без подсказок.' },
    on_edge:       { icon: '😰', title: 'На волоске',       desc: 'Золото, совершив две ошибки (осталось одно сердечко).' },
    universal:     { icon: '🎓', title: 'Универсал',        desc: 'Золото по всем трём темам за один день.' },
    marathon:      { icon: '🏃', title: 'Марафонец',         desc: 'Стрик 7 дней подряд в одной теме.' },
    first_session: { icon: '🚀', title: 'Первый шаг',        desc: 'Завершить первую тренировку.' },
    no_hints:      { icon: '💡', title: 'Самостоятельный',   desc: 'Завершить тренировку без единой подсказки.' },
    streak_3:      { icon: '🔥', title: 'В ударе',           desc: 'Заниматься 3 дня подряд.' },
    streak_30:     { icon: '🗓️', title: 'Месяц дисциплины', desc: 'Заниматься 30 дней подряд.' },
    hundred:       { icon: '💯', title: 'Сотник',            desc: 'Сыграть 100 тренировок.' },
    curious:       { icon: '🤔', title: 'Любопытный',        desc: 'Нажать на запрещённый калькулятор.' }
};

// Правила выдачи: [id, условие]
const ACH_CHECKS = [
    ['first_gold',    c => c.medal === 'gold'],
    ['flawless',      c => c.medal === 'gold' && c.heartsLeft === 3 && c.hints === 0],
    ['on_edge',       c => c.medal === 'gold' && c.heartsLeft === 1],
    ['universal',     c => c.goldTopicsToday >= 3],
    ['marathon',      c => c.topicStreak >= 7],
    ['first_session', c => c.games >= 1],
    ['no_hints',      c => c.hints === 0],
    ['streak_3',      c => c.newStreak >= 3],
    ['streak_30',     c => c.newStreak >= 30],
    ['hundred',       c => c.games >= 100],
    ['curious',       c => c.triedCalculator]
];

function evaluateAchievements(ctx, owned) {
    return ACH_CHECKS
        .filter(([id, check]) => !owned.includes(id) && check(ctx))
        .map(([id]) => id);
}

app.get('/api/achievements', (req, res) => {
    res.json(Object.entries(ACHIEVEMENTS).map(([id, a]) => ({ id, ...a })));
});

// --- API РОУТЫ ---
app.get('/api/students', (req, res) => {
    db.all("SELECT id, name, class_name FROM students ORDER BY class_name, name", [], (err, rows) => {
        res.json(rows);
    });
});

// Командный зачёт классов: +1 очко за золото (не чаще 1 раза в день по каждой теме).
// В зачёт идут только ученики, отыгравшие за неделю не меньше MIN_DAYS_FOR_SCORE дней.
app.get('/api/team-standings', (req, res) => {
    const { mondayStr, today } = getWeekInfo();

    const sqlStudents = `
        SELECT s.class_name AS class_name,
               COUNT(DISTINCT sess.date) AS active_days,
               COUNT(DISTINCT CASE WHEN sess.medal = 'gold'
                   THEN sess.student_id || '|' || sess.topic_id || '|' || sess.date END) AS golds
        FROM students s
        LEFT JOIN sessions sess
               ON sess.student_id = s.id
              AND sess.date >= ? AND sess.date <= ?
        WHERE s.class_name IS NOT NULL AND s.class_name != ''
        GROUP BY s.id
    `;

    const sqlClasses = `
        SELECT class_name, COUNT(*) AS students
        FROM students
        WHERE class_name IS NOT NULL AND class_name != ''
        GROUP BY class_name
    `;

    let perStudent = [];
    let classSizes = [];

    runAsync([
        next => db.all(sqlStudents, [mondayStr, today], (e, rows) => { perStudent = rows || []; next(); }),
        next => db.all(sqlClasses, [], (e, rows) => { classSizes = rows || []; next(); })
    ], () => {
        const byClass = {};
        const ensure = name => byClass[name] || (byClass[name] = { class_name: name, students: 0, points: 0, scored: 0 });

        classSizes.forEach(r => { ensure(r.class_name).students = r.students; });
        perStudent.forEach(r => {
            const t = ensure(r.class_name);
            if ((r.active_days || 0) >= MIN_DAYS_FOR_SCORE) {
                t.points += r.golds || 0;
                t.scored += 1;
            }
        });

        const teams = Object.values(byClass).map(t => ({
            class_name: t.class_name,
            students: t.students,
            points: t.points,
            scored: t.scored,
            max: t.students * TOPICS_COUNT * MIN_DAYS_FOR_SCORE
        })).sort((a, b) => b.points - a.points || a.class_name.localeCompare(b.class_name));

        res.json({ weekStart: mondayStr, today, minDays: MIN_DAYS_FOR_SCORE, teams });
    });
});

// НОВЫЙ РОУТ ДЛЯ ПРОГРЕССА
app.get('/api/student-progress/:id', (req, res) => {
    const studentId = req.params.id;
    const today = getTodayDate();

    db.get("SELECT achievements, streak FROM students WHERE id = ?", [studentId], (err, student) => {
        if (err || !student) return res.status(404).json({ error: 'Ученик не найден' });

        db.all("SELECT topic_id, medal FROM sessions WHERE student_id = ? AND date = ?", [studentId, today], (err, sessions) => {
            db.all("SELECT topic_id, streak FROM topic_progress WHERE student_id = ?", [studentId], (err, topicStreaks) => {
                
                // Формируем объект вида { factor: 2, nod: 0, nok: 5 }
                const streaksDict = {};
                topicStreaks.forEach(ts => streaksDict[ts.topic_id] = ts.streak);

                res.json({
                    streak: student.streak || 0,
                    achievements: JSON.parse(student.achievements || '[]'),
                    todayTopics: sessions.map(s => ({ topic: s.topic_id, medal: s.medal })),
                    topicStreaks: streaksDict
                });
            });
        });
    });
});

app.post('/api/save-result', (req, res) => {
    const { studentId, topicId, medal, score, hintsUsed, hearts } = req.body;
    const today = getTodayDate();
    const yesterday = getYesterdayDate();
    const hints = hintsUsed || 0;
    const heartsLeft = (typeof hearts === 'number') ? hearts : 3;

    db.get("SELECT streak, last_played_date, achievements FROM students WHERE id = ?", [studentId], (err, student) => {
        if (err || !student) return res.status(404).json({ error: 'Ученик не найден' });

        let newStreak = student.streak;
        if (student.last_played_date !== today) {
            newStreak = (student.last_played_date === yesterday) ? student.streak + 1 : 1;
        }

        const owned = JSON.parse(student.achievements || '[]');

        // 1) Сохраняем сессию
        db.run("INSERT INTO sessions (student_id, topic_id, date, medal, score, hints_used) VALUES (?, ?, ?, ?, ?, ?)",
            [studentId, topicId, today, medal, score, hints], () => {

            // 2) Обновляем стрик по конкретной теме (уровню)
            db.get("SELECT streak, last_played_date FROM topic_progress WHERE student_id = ? AND topic_id = ?",
                [studentId, topicId], (err2, tp) => {
                let topicStreak = 1;
                if (tp) {
                    if (tp.last_played_date === today) topicStreak = tp.streak;
                    else if (tp.last_played_date === yesterday) topicStreak = tp.streak + 1;
                }
                db.run("INSERT OR REPLACE INTO topic_progress (student_id, topic_id, streak, last_played_date) VALUES (?, ?, ?, ?)",
                    [studentId, topicId, topicStreak, today], () => {

                    // 3) Данные для достижений (считаем параллельно)
                    const ctx = { medal, hints, heartsLeft, topicStreak, newStreak, games: 0, goldTopicsToday: 0, triedCalculator: false };
                    runAsync([
                        next => db.get("SELECT COUNT(*) AS c FROM sessions WHERE student_id = ?", [studentId], (e, r) => { ctx.games = r.c || 0; next(); }),
                        next => db.get("SELECT COUNT(DISTINCT topic_id) AS c FROM sessions WHERE student_id = ? AND date = ? AND medal = 'gold'", [studentId, today], (e, r) => { ctx.goldTopicsToday = r.c || 0; next(); }),
                        next => db.get("SELECT COUNT(*) AS c FROM logs WHERE student_id = ? AND action = 'open_calculator'", [studentId], (e, r) => { ctx.triedCalculator = (r.c || 0) > 0; next(); })
                    ], () => {
                        const newlyUnlocked = evaluateAchievements(ctx, owned);
                        const all = owned.concat(newlyUnlocked);
                        db.run("UPDATE students SET streak = ?, last_played_date = ?, achievements = ? WHERE id = ?",
                            [newStreak, today, JSON.stringify(all), studentId], () => {
                            res.json({ success: true, newAchievements: newlyUnlocked });
                        });
                    });
                });
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
    const { monday, mondayStr, today } = getWeekInfo();

    const weekDays = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        weekDays.push(d.toISOString().split('T')[0]);
    }

    const mainQuery = `
        SELECT s.id, s.name, s.class_name, s.streak, s.last_played_date,
            COUNT(sess.id) as total_games,
            SUM(CASE WHEN sess.medal = 'gold' THEN 1 ELSE 0 END) as total_gold
        FROM students s
        LEFT JOIN sessions sess ON s.id = sess.student_id
        GROUP BY s.id ORDER BY s.class_name, s.name
    `;

    db.all(mainQuery, [], (err, rows) => {
        if (err) return res.status(500).send('Ошибка БД');

        // Сессии за текущую неделю (Пн..сегодня)
        db.all("SELECT student_id, date, medal FROM sessions WHERE date >= ? AND date <= ?",
            [mondayStr, today], (err2, weekRows) => {

            // student_id -> { date -> 'gold' | 'silver' } (gold приоритетнее)
            const weekBest = {};
            weekRows.forEach(r => {
                const byDay = weekBest[r.student_id] || (weekBest[r.student_id] = {});
                if (r.medal === 'gold') byDay[r.date] = 'gold';
                else if (!byDay[r.date]) byDay[r.date] = 'silver';
            });

            const classes = [...new Set(rows.map(r => r.class_name).filter(Boolean))].sort();
            const playedToday = rows.filter(r => weekBest[r.id] && weekBest[r.id][today]).length;
            const totalStudents = rows.length;

            const style = `<style>
                body{font-family:sans-serif; padding:20px; color:#333;}
                h2{margin-top:0;}
                .dashboard{background:#eaf3ff; border:1px solid #cfe1ff; border-radius:10px; padding:14px 18px; margin-bottom:16px; font-size:1.1rem;}
                .dashboard b{color:#2f6fed;}
                .form-box{background:#eee; padding:15px; margin-bottom:16px; border-radius:8px;}
                .controls{margin-bottom:12px;}
                .controls select{padding:8px 12px; font-size:1rem; border-radius:8px; border:1px solid #ccc;}
                table{border-collapse:collapse; width:100%; font-size:0.95rem;}
                th,td{border:1px solid #ddd; padding:6px 8px; text-align:center;}
                th{background:#f4f7f9; position:sticky; top:0;}
                .week .day{font-size:1.05rem; margin:0 1px;}
                .status{font-size:1.2rem;}
            </style>`;

            let html = `<meta charset="UTF-8">${style}
                <h2>Панель учителя</h2>
                <div class="dashboard">Сегодня сыграло: <b>${playedToday}</b> из <b>${totalStudents}</b> учеников</div>
                <div class="form-box">
                    <form action="/admin/add-student" method="POST" style="display:flex; gap:10px; flex-wrap:wrap;">
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
                <div class="controls">Класс:
                    <select id="classFilter" onchange="filterTable()">
                        <option value="">Все</option>
                        ${classes.map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                </div>
                <table id="studentsTable">
                    <thead><tr>
                        <th>Статус сегодня</th><th>Класс</th><th>Ученик</th>
                        <th>Прогресс за неделю</th><th>Стрик</th><th>Золото</th><th>Игр</th><th>Логи</th>
                    </tr></thead>
                    <tbody>`;
            rows.forEach(r => {
                const byDay = weekBest[r.id] || {};
                const todayMedal = byDay[today];
                const status = todayMedal === 'gold' ? '✅' : (todayMedal === 'silver' ? '☑️' : '❌');

                const weekCell = weekDays.map(dateStr => {
                    const m = byDay[dateStr];
                    const icon = m === 'gold' ? '🥇' : (m === 'silver' ? '🥈' : '⬜');
                    const label = dateStr.slice(8, 10) + '.' + dateStr.slice(5, 7);
                    return `<span class="day" title="${label}">${icon}</span>`;
                }).join('');

                html += `<tr data-class="${r.class_name || ''}">
                    <td class="status">${status}</td>
                    <td>${r.class_name || '-'}</td>
                    <td style="text-align:left;">${r.name}</td>
                    <td class="week">${weekCell}</td>
                    <td>${r.streak}</td>
                    <td>${r.total_gold}</td>
                    <td>${r.total_games}</td>
                    <td><a href="/admin/logs/${r.id}">Смотреть</a></td>
                </tr>`;
            });

            html += `</tbody></table>
                <script>
                    function filterTable() {
                        const v = document.getElementById('classFilter').value;
                        document.querySelectorAll('#studentsTable tbody tr').forEach(tr => {
                            tr.style.display = (!v || tr.getAttribute('data-class') === v) ? '' : 'none';
                        });
                    }
                </script>`;

            res.send(html);
        });
    });
});

app.get('/admin/logs/:studentId', adminAuth, (req, res) => {
    db.all("SELECT * FROM logs WHERE student_id = ? ORDER BY created_at DESC LIMIT 50", [req.params.studentId], (err, rows) => {
        let html = `<meta charset="UTF-8"><style>body{font-family:sans-serif;} .cheat{background:#fee2e2;}</style><h2>Логи (Ученик: ${req.params.studentId})</h2><a href="/admin">← Назад</a><br><br><table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;"><tr><th>Время</th><th>Действие</th><th>Время решения</th><th>Ввод</th></tr>`;
        
        rows.forEach(r => {
            let details = {};
            try { details = JSON.parse(r.details); } catch(e){}
            
            // Если ответил правильно быстрее 3 секунд
            const isSuspicious = (r.action === 'answer_submit' && details.correct && details.timeSec < 3);
            const trClass = isSuspicious ? 'class="cheat"' : '';
            
            html += `<tr ${trClass}>
                <td>${new Date(r.created_at).toLocaleTimeString('ru-RU')}</td>
                <td>${r.action} ${details.correct ? '✅' : (details.correct === false ? '❌' : '')}</td>
                <td>${details.timeSec !== undefined ? details.timeSec + ' сек' : '-'} ${isSuspicious ? '🚩' : ''}</td>
                <td>${details.input || '-'}</td>
            </tr>`;
        });
        res.send(html + `</table>`);
    });
});

app.listen(PORT, () => console.log('Сервер: http://localhost:' + PORT));
