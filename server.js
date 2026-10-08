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

    // Справочник классов (нужен, чтобы помечать целый класс как тестовый)
    db.run(`CREATE TABLE IF NOT EXISTS classes (
        name TEXT PRIMARY KEY,
        is_test INTEGER DEFAULT 0
    )`);

    // Флаг «тестовый» у ученика. ALTER выполняем, только если колонки ещё нет.
    db.all("PRAGMA table_info(students)", (e, cols) => {
        if (!cols.some(c => c.name === 'is_test')) {
            db.run("ALTER TABLE students ADD COLUMN is_test INTEGER DEFAULT 0");
        }
    });

    // Заполняем справочник классов текущими значениями
    db.run("INSERT OR IGNORE INTO classes (name) SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name != ''");

    // --- Устройства (античит) ---
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        hash TEXT PRIMARY KEY,
        ua TEXT, platform TEXT, screen TEXT, viewport TEXT, dpr REAL,
        lang TEXT, langs TEXT, tz TEXT, tz_offset INTEGER,
        touch INTEGER, coarse INTEGER, cores INTEGER, memory INTEGER,
        dnt TEXT, standalone INTEGER,
        first_seen TEXT, last_seen TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS student_devices (
        student_id TEXT, device_hash TEXT,
        first_seen TEXT, last_seen TEXT, sessions INTEGER DEFAULT 0,
        PRIMARY KEY (student_id, device_hash)
    )`);

    // Колонка отпечатка в логах и сессиях (ALTER — только если колонки ещё нет)
    db.all("PRAGMA table_info(logs)", (e1, c1) => {
        if (!c1.some(c => c.name === 'device_hash')) {
            db.run("ALTER TABLE logs ADD COLUMN device_hash TEXT");
        }
    });
    db.all("PRAGMA table_info(sessions)", (e2, c2) => {
        if (!c2.some(c => c.name === 'device_hash')) {
            db.run("ALTER TABLE sessions ADD COLUMN device_hash TEXT");
        }
    });
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
const MIN_DAYS_FOR_SCORE = 1;  // столько дней нужно, чтобы попасть в зачёт
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
    // Сортируем по логину (id), а показываем имя
    db.all("SELECT id, name, class_name, is_test FROM students ORDER BY class_name, id", [], (err, rows) => {
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
          AND s.is_test = 0
          AND s.class_name NOT IN (SELECT name FROM classes WHERE is_test = 1)
        GROUP BY s.id
    `;

    const sqlClasses = `
        SELECT s.class_name AS class_name, COUNT(*) AS students
        FROM students s
        WHERE s.class_name IS NOT NULL AND s.class_name != ''
          AND s.is_test = 0
          AND s.class_name NOT IN (SELECT name FROM classes WHERE is_test = 1)
        GROUP BY s.class_name
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
    const { studentId, topicId, medal, score, hintsUsed, hearts, deviceHash } = req.body;
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
        db.run("INSERT INTO sessions (student_id, topic_id, date, medal, score, hints_used, device_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [studentId, topicId, today, medal, score, hints, deviceHash || null], () => {

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
                    if (deviceHash) db.run("UPDATE student_devices SET sessions = sessions + 1, last_seen = ? WHERE student_id = ? AND device_hash = ?", [today, studentId, deviceHash]);

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
    const { studentId, action, details, deviceHash } = req.body;
    if (!studentId) return res.status(400).send('No student');
    db.run("INSERT INTO logs (student_id, action, details, device_hash) VALUES (?, ?, ?, ?)",
        [studentId, action, JSON.stringify(details), deviceHash || null], (err) => {
        res.sendStatus(200);
    });
});

// --- УСТРОЙСТВА (античит: только предупреждаем, ничего не блокируем) ---
const DEVICE_ALERT_THRESHOLD = 3;   // столько разных учеников на устройстве за день = подозрительно

function readDevice(payload) {
    if (!payload || !payload.hash) return null;
    return {
        hash: String(payload.hash).slice(0, 32),
        ua: payload.ua || '',
        platform: payload.platform || '',
        screen: payload.screen || '',
        viewport: payload.viewport || '',
        dpr: payload.dpr || null,
        lang: payload.lang || '',
        langs: payload.langs || '',
        tz: payload.tz || '',
        tz_offset: (payload.tzOffset === undefined ? null : payload.tzOffset),
        touch: payload.touch || 0,
        coarse: payload.coarse ? 1 : 0,
        cores: payload.cores || 0,
        memory: payload.memory || null,
        dnt: payload.dnt || '',
        standalone: payload.standalone ? 1 : 0
    };
}

app.post('/api/device/register', (req, res) => {
    const studentId = req.body.studentId;
    const dev = readDevice(req.body.device);
    if (!studentId || !dev) return res.sendStatus(204);

    const now = new Date().toISOString();

    db.run(`INSERT INTO devices
              (hash, ua, platform, screen, viewport, dpr, lang, langs, tz, tz_offset,
               touch, coarse, cores, memory, dnt, standalone, first_seen, last_seen)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(hash) DO UPDATE SET
              ua = excluded.ua, platform = excluded.platform, screen = excluded.screen,
              viewport = excluded.viewport, dpr = excluded.dpr, lang = excluded.lang,
              langs = excluded.langs, tz = excluded.tz, tz_offset = excluded.tz_offset,
              touch = excluded.touch, coarse = excluded.coarse, cores = excluded.cores,
              memory = excluded.memory, dnt = excluded.dnt, standalone = excluded.standalone,
              last_seen = excluded.last_seen`,
        [dev.hash, dev.ua, dev.platform, dev.screen, dev.viewport, dev.dpr, dev.lang, dev.langs,
         dev.tz, dev.tz_offset, dev.touch, dev.coarse, dev.cores, dev.memory, dev.dnt,
         dev.standalone, now, now], () => {

        db.run("INSERT OR IGNORE INTO student_devices (student_id, device_hash, first_seen, last_seen, sessions) VALUES (?, ?, ?, ?, 0)",
            [studentId, dev.hash, now, now], () => {
            db.run("UPDATE student_devices SET last_seen = ? WHERE student_id = ? AND device_hash = ?",
                [now, studentId, dev.hash], () => res.json({ ok: true, hash: dev.hash }));
        });
    });
});

app.post('/api/device/leave', (req, res) => {
    const { studentId, deviceHash } = req.body;
    if (!studentId || !deviceHash) return res.sendStatus(204);
    db.run("UPDATE student_devices SET last_seen = ? WHERE student_id = ? AND device_hash = ?",
        [new Date().toISOString(), studentId, deviceHash], () => res.sendStatus(200));
});

// Сигналы по устройствам за сегодня (тестовые исключены)
function getDeviceSignals(today, cb) {
    const exclude = " AND s.is_test = 0 AND s.class_name NOT IN (SELECT name FROM classes WHERE is_test = 1)";
    const sqlPairs = `
        SELECT l.device_hash AS hash, l.student_id AS sid, s.name AS name, s.class_name AS cls
        FROM logs l JOIN students s ON s.id = l.student_id
        WHERE l.device_hash IS NOT NULL AND date(l.created_at) = ?${exclude}`;
    const sqlOverlap = `
        SELECT a.device_hash AS hash
        FROM logs a
        JOIN logs b ON b.device_hash = a.device_hash AND b.student_id <> a.student_id
                  AND b.action = 'answer_submit' AND b.created_at < a.created_at
                  AND b.created_at >= datetime(a.created_at, '-10 minutes')
        JOIN students sa ON sa.id = a.student_id
        WHERE a.device_hash IS NOT NULL AND a.action = 'answer_submit'
          AND date(a.created_at) = ?
          AND sa.is_test = 0 AND sa.class_name NOT IN (SELECT name FROM classes WHERE is_test = 1)
        GROUP BY a.device_hash`;

    let pairs = [];
    let overlaps = [];
    runAsync([
        next => db.all(sqlPairs, [today], (e, r) => { pairs = r || []; next(); }),
        next => db.all(sqlOverlap, [today], (e, r) => { overlaps = r || []; next(); })
    ], () => {
        const overlapSet = new Set(overlaps.map(r => r.hash));
        const byDevice = {};
        const byStudent = {};
        pairs.forEach(r => {
            const d = byDevice[r.hash] || (byDevice[r.hash] = { hash: r.hash, count: 0, students: {}, names: [] });
            if (!d.students[r.sid]) { d.students[r.sid] = true; d.count++; d.names.push({ name: r.name, cls: r.cls }); }
            byStudent[r.sid] = r.hash;
        });
        Object.values(byDevice).forEach(d => { d.overlap = overlapSet.has(d.hash); delete d.students; });
        cb({ byDevice, byStudent, overlaps: [...overlapSet] });
    });
}

// Красивое название устройства из user-agent
function describeDevice(d) {
    if (!d) return '—';
    const ua = d.ua || '';
    let os = '💻 ОС неизвестна';
    if (/iPhone/i.test(ua)) os = '📱 iPhone';
    else if (/iPad/i.test(ua)) os = '📲 iPad';
    else if (/Android/i.test(ua)) os = '🤖 Android';
    else if (/Windows/i.test(ua)) os = '🖥 Windows';
    else if (/Mac OS X/i.test(ua)) os = '💻 macOS';
    else if (/Linux/i.test(ua)) os = '🐧 Linux';

    let br = 'браузер';
    if (/Edg\//i.test(ua)) br = 'Edge';
    else if (/Chrome\//i.test(ua)) br = 'Chrome';
    else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) br = 'Safari';
    else if (/Firefox\//i.test(ua)) br = 'Firefox';
    return `${os} · ${br}`;
}


// --- АДМИНКА ---
const adminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).setHeader('WWW-Authenticate', 'Basic').send('');
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === 'teacher' && auth[1] === 'math123') next();
    else res.status(401).setHeader('WWW-Authenticate', 'Basic').send('');
};

// Массовое добавление: payload = JSON [{ id, name, class_name, is_test }]
app.post('/admin/add-student', adminAuth, (req, res) => {
    let items = [];
    try { items = JSON.parse(req.body.payload || '[]'); } catch (e) { items = []; }
    items = items.filter(it => it && it.id && it.name);
    if (!items.length) return res.redirect('/admin');

    runAsync(items.map(it => next => {
        const cls = (it.class_name || '').trim();
        db.run("INSERT OR IGNORE INTO students (id, name, class_name, is_test) VALUES (?, ?, ?, ?)",
            [it.id.trim(), it.name.trim(), cls, it.is_test ? 1 : 0], () => {
            if (cls) db.run("INSERT OR IGNORE INTO classes (name) VALUES (?)", [cls], () => next());
            else next();
        });
    }), () => res.redirect('/admin'));
});

// Редактирование ученика
app.get('/admin/edit/:id', adminAuth, (req, res) => {
    db.get("SELECT id, name, class_name, is_test FROM students WHERE id = ?", [req.params.id], (err, s) => {
        if (err || !s) return res.status(404).send('Ученик не найден');
        db.all("SELECT name, is_test FROM classes ORDER BY name", [], (e2, classes) => {
            const opts = classes.map(c =>
                `<option value="${c.name}" ${c.name === s.class_name ? 'selected' : ''}>${c.name}${c.is_test ? ' (тест)' : ''}</option>`
            ).join('');
            res.send(`<meta charset="UTF-8">
<style>body{font-family:sans-serif; padding:20px;} .box{background:#eee; padding:16px; border-radius:8px; max-width:420px;}
input,select{padding:8px; font-size:1rem; margin:4px 0;} button{padding:10px 18px; font-size:1rem; cursor:pointer;}</style>
<h2>Ученик: ${s.id}</h2>
<form class="box" action="/admin/edit/${s.id}" method="POST">
    <div><input type="text" name="name" value="${s.name}" required></div>
    <div><select name="class_name">${opts}</select></div>
    <div><label><input type="checkbox" name="is_test" value="1" ${s.is_test ? 'checked' : ''}> тестовый аккаунт</label></div>
    <div style="margin-top:10px;"><button type="submit">Сохранить</button> <a href="/admin">← Назад</a></div>
</form>`);
        });
    });
});

app.post('/admin/edit/:id', adminAuth, (req, res) => {
    const { name, class_name, is_test } = req.body;
    const cls = (class_name || '').trim();
    db.run("UPDATE students SET name = ?, class_name = ?, is_test = ? WHERE id = ?",
        [name || req.params.id, cls, is_test ? 1 : 0, req.params.id], (e) => {
        if (cls) db.run("INSERT OR IGNORE INTO classes (name) VALUES (?)", [cls]);
        res.redirect('/admin');
    });
});

// Удаление ученика вместе с его сессиями, прогрессом и логами
app.post('/admin/delete/:id', adminAuth, (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM sessions WHERE student_id = ?", [id], () => {
        db.run("DELETE FROM topic_progress WHERE student_id = ?", [id], () => {
            db.run("DELETE FROM logs WHERE student_id = ?", [id], () => {
                db.run("DELETE FROM students WHERE id = ?", [id], () => res.redirect('/admin'));
            });
        });
    });
});

// Классы: переключить флаг «тестовый»
app.post('/admin/class/toggle', adminAuth, (req, res) => {
    const cls = (req.body.class_name || '').trim();
    if (!cls) return res.redirect('/admin');
    db.run("INSERT OR IGNORE INTO classes (name) VALUES (?)", [cls], () => {
        db.run("UPDATE classes SET is_test = ? WHERE name = ?", [req.body.is_test ? 1 : 0, cls], () => res.redirect('/admin'));
    });
});

// Классы: добавить новый
app.post('/admin/class/add', adminAuth, (req, res) => {
    const cls = (req.body.class_name || '').trim();
    if (cls) db.run("INSERT OR IGNORE INTO classes (name) VALUES (?)", [cls]);
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
        SELECT s.id, s.name, s.class_name, s.streak, s.last_played_date, s.is_test,
            COUNT(sess.id) as total_games,
            SUM(CASE WHEN sess.medal = 'gold' THEN 1 ELSE 0 END) as total_gold
        FROM students s
        LEFT JOIN sessions sess ON s.id = sess.student_id
        GROUP BY s.id ORDER BY s.class_name, s.id
    `;

    db.all(mainQuery, [], (err, rows) => {
        if (err) return res.status(500).send('Ошибка БД');

        let weekRows = [];
        let classRows = [];
        let deviceMap = { byDevice: {}, byStudent: {}, overlaps: [] };
        runAsync([
            next => db.all("SELECT student_id, date, medal FROM sessions WHERE date >= ? AND date <= ?",
                [mondayStr, today], (e, r) => { weekRows = r || []; next(); }),
            next => db.all("SELECT name, is_test FROM classes ORDER BY name", [], (e, r) => { classRows = r || []; next(); }),
            next => getDeviceSignals(today, m => { deviceMap = m; next(); })
        ], () => {

            // student_id -> { date -> 'gold' | 'silver' } (gold приоритетнее)
            const weekBest = {};
            weekRows.forEach(r => {
                const byDay = weekBest[r.student_id] || (weekBest[r.student_id] = {});
                if (r.medal === 'gold') byDay[r.date] = 'gold';
                else if (!byDay[r.date]) byDay[r.date] = 'silver';
            });

            const testClasses = new Set(classRows.filter(c => c.is_test).map(c => c.name));
            const isTestStudent = r => !!r.is_test || testClasses.has(r.class_name);

            const classes = [...new Set(rows.map(r => r.class_name).filter(Boolean))].sort();
            const rated = rows.filter(r => !isTestStudent(r));
            const playedToday = rated.filter(r => weekBest[r.id] && weekBest[r.id][today]).length;
            const totalStudents = rated.length;
            const classNames = classRows.length ? classRows.map(c => c.name) : classes;
            const classOptions = classNames.map(c => `<option value="${c}">${c}</option>`).join('');

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
                <div class="controls"><a href="/admin/devices">📱 Устройства и подозрения</a></div>
                <div class="dashboard">Сегодня сыграло: <b>${playedToday}</b> из <b>${totalStudents}</b> учеников</div>
                <div class="form-box">
                    <div style="font-weight:bold; margin-bottom:8px;">Добавить учеников</div>
                    <form action="/admin/add-student" method="POST" id="addForm">
                        <div id="addRows"></div>
                        <input type="hidden" name="payload" id="addPayload">
                        <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
                            <button type="button" onclick="addRow()">+ Добавить ещё</button>
                            <button type="submit">Сохранить всё</button>
                        </div>
                    </form>
                </div>
                <div class="form-box">
                    <div style="font-weight:bold; margin-bottom:8px;">Классы</div>
                    <div id="classList" style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px;">
                        ${classRows.map(c => `
                            <form action="/admin/class/toggle" method="POST" style="display:flex; gap:4px; align-items:center;">
                                <input type="hidden" name="class_name" value="${c.name}">
                                <input type="hidden" name="is_test" value="${c.is_test ? '0' : '1'}">
                                <span>${c.name}</span>
                                <button type="submit">${c.is_test ? '🧪 тест' : 'обычный'}</button>
                            </form>`).join('') || '<i>Классов пока нет</i>'}
                    </div>
                    <form action="/admin/class/add" method="POST" style="display:flex; gap:8px;">
                        <input type="text" name="class_name" placeholder="Название класса" required>
                        <button type="submit">+ Класс</button>
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
                        <th>Прогресс за неделю</th><th>Стрик</th><th>Золото</th><th>Игр</th><th>Устройство</th><th>Логи</th>
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

                const test = isTestStudent(r);

                const devHash = deviceMap.byStudent[r.id];
                const devInfo = devHash ? deviceMap.byDevice[devHash] : null;
                const suspicious = !!devInfo && (devInfo.count >= DEVICE_ALERT_THRESHOLD || devInfo.overlap);
                const devCell = devHash
                    ? `<code>${devHash.slice(0, 8)}</code>${suspicious ? ' <b title="Несколько учеников с одного устройства">⚠️</b>' : ''}`
                    : '—';

                html += `<tr data-class="${r.class_name || ''}" style="${test ? 'opacity:.55;' : ''}">
                    <td class="status">${status}</td>
                    <td>${r.class_name || '-'}${test ? ' 🧪' : ''}</td>
                    <td style="text-align:left;">${r.name}</td>
                    <td class="week">${weekCell}</td>
                    <td>${r.streak}</td>
                    <td>${r.total_gold}</td>
                    <td>${r.total_games}</td>
                    <td>${devCell}</td>
                    <td style="white-space:nowrap;">
                        <a href="/admin/logs/${r.id}">Логи</a> ·
                        <a href="/admin/edit/${r.id}">Изменить</a> ·
                        <form action="/admin/delete/${r.id}" method="POST" style="display:inline;" onsubmit="return confirm('Удалить ученика ${r.id}? Его сессии и логи тоже будут удалены.');">
                            <button type="submit" style="padding:2px 8px; cursor:pointer;">Удалить</button>
                        </form>
                    </td>
                </tr>`;
            });

            html += `</tbody></table>
                <script>
                    var CLASS_OPTIONS = '${classOptions}';

                    function addRow() {
                        var div = document.getElementById('addRows');
                        var row = document.createElement('div');
                        row.style.cssText = 'display:flex; gap:8px; margin-bottom:6px; flex-wrap:wrap;';
                        row.innerHTML = '<input type="text" placeholder="Логин (a1)">'
                            + ' <input type="text" placeholder="Фамилия Имя">'
                            + ' <select>' + CLASS_OPTIONS + '</select>'
                            + ' <label><input type="checkbox"> тест</label>';
                        div.appendChild(row);
                    }

                    function collectRows() {
                        var items = [];
                        document.querySelectorAll('#addRows > div').forEach(function (row) {
                            var i = row.querySelectorAll('input[type=text]');
                            var sel = row.querySelector('select');
                            var chk = row.querySelector('input[type=checkbox]');
                            items.push({ id: i[0].value.trim(), name: i[1].value.trim(), class_name: sel ? sel.value : '', is_test: chk ? chk.checked : false });
                        });
                        items = items.filter(function (x) { return x.id && x.name; });
                        document.getElementById('addPayload').value = JSON.stringify(items);
                        if (!items.length) alert('Заполните логин и имя хотя бы для одного ученика');
                    }

                    function filterTable() {
                        var v = document.getElementById('classFilter').value;
                        document.querySelectorAll('#studentsTable tbody tr').forEach(function (tr) {
                            tr.style.display = (!v || tr.getAttribute('data-class') === v) ? '' : 'none';
                        });
                    }

                    addRow();
                    document.getElementById('addForm').addEventListener('submit', collectRows);
                </script>`;

            res.send(html);
        });
    });
});

// Страница устройств: кто с одного телефона занимался
app.get('/admin/devices', adminAuth, (req, res) => {
    const today = getTodayDate();
    getDeviceSignals(today, sig => {
        const hashes = Object.keys(sig.byDevice);
        if (!hashes.length) {
            return res.send('<meta charset="UTF-8"><p style="font-family:sans-serif; padding:20px;">Данных об устройствах пока нет. <a href="/admin">← Назад</a></p>');
        }
        db.all("SELECT * FROM devices", [], (e, devs) => {
            const info = {};
            devs.forEach(d => { info[d.hash] = d; });
            const list = hashes.map(h => ({ h, s: sig.byDevice[h], d: info[h] })).sort((a, b) => b.s.count - a.s.count);

            const style = '<style>body{font-family:sans-serif; padding:20px; color:#333;} table{border-collapse:collapse; width:100%; font-size:0.95rem;} th,td{border:1px solid #ddd; padding:6px 8px; text-align:left;} th{background:#f4f7f9;} .warn{background:#fff4e5;} code{background:#f0f0f0; padding:1px 4px;} button{padding:8px 14px;}</style>';

            let html = `<meta charset="UTF-8">${style}
                <h2>Устройства (сегодня)</h2>
                <p>Порог подозрения: <b>${DEVICE_ALERT_THRESHOLD}</b> разных ученика с одного устройства за день. Тестовые ученики и тестовые классы не учитываются.</p>
                <form action="/admin/devices/purge" method="POST" onsubmit="return confirm('Удалить всю статистику устройств и отпечатки из логов?');">
                    <button type="submit">Очистить статистику устройств</button>
                </form>
                <table><tr><th>Отпечаток</th><th>Устройство</th><th>Сегодня заходили</th><th>Кто</th><th>Экран</th><th>Последняя активность</th></tr>`;

            list.forEach(x => {
                const d = x.d || {};
                const warn = x.s.count >= DEVICE_ALERT_THRESHOLD || x.s.overlap;
                const who = (x.s.names || []).map(n => `${n.name} (${n.cls || '-'})`).join(', ');
                html += `<tr class="${warn ? 'warn' : ''}">
                    <td><code>${x.h.slice(0, 8)}</code>${warn ? ' ⚠️' : ''}</td>
                    <td>${describeDevice(d)}</td>
                    <td>${x.s.count}${x.s.overlap ? ' · пересечение по времени' : ''}</td>
                    <td>${who}</td>
                    <td>${d.screen || '—'}</td>
                    <td>${(d.last_seen || '').slice(0, 16).replace('T', ' ')}</td>
                </tr>`;
            });

            html += '</table><p><a href="/admin">← Назад</a></p>';
            res.send(html);
        });
    });
});

// Полная очистка данных об устройствах (152-ФЗ: нужно уметь удалять)
app.post('/admin/devices/purge', adminAuth, (req, res) => {
    db.run("UPDATE logs SET device_hash = NULL", () => {
        db.run("DELETE FROM student_devices", () => {
            db.run("DELETE FROM devices", () => res.redirect('/admin/devices'));
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
