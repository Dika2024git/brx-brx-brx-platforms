// index.js
// Mengimpor library yang dibutuhkan
const express = require('express');
const fs = require('fs').promises; // Menggunakan promise-based fs
const path = require('path');
const { parseStringPromise } = require('xml2js');
const Fuse = require('fuse.js');
const LanguageDetect = require('language-detect');
const natural = require('natural');

// Inisialisasi aplikasi Express
const app = express();
app.use(express.json()); // Middleware untuk parsing JSON body

// Path ke file data dan log
const DATA_XML_PATH = path.join(__dirname, 'data.xml');
const LOG_JSON_PATH = path.join(__dirname, 'log.json');

// Variabel global untuk menyimpan "otak" chatbot
let chatbotData = [];
let fallbackIntent = null;

// Inisialisasi tokenizer
const tokenizer = new natural.WordTokenizer();

/**
 * Fungsi untuk memuat dan mem-parsing data.xml.
 * Data diubah menjadi struktur yang lebih mudah digunakan oleh Fuse.js.
 */
async function loadChatbotData() {
    try {
        console.log('Membaca dan memproses data.xml...');
        const xmlData = await fs.readFile(DATA_XML_PATH, 'utf8');
        const parsedData = await parseStringPromise(xmlData);

        const intents = parsedData.chatbot.intent;
        let processedData = [];

        for (const intent of intents) {
            const intentName = intent.$.name;
            const threshold = parseFloat(intent.$.threshold || 0.4); // Default threshold

            // Menangani intent fallback secara khusus
            if (intentName === 'fallback') {
                fallbackIntent = {
                    name: intentName,
                    answers: intent.qa[0].answer.map(ans => ans._ || ans)
                };
                continue; // Lanjut ke intent berikutnya
            }

            if (intent.qa) {
                for (const qa of intent.qa) {
                    const questions = qa.question;
                    const answers = qa.answer.map(ans => ans._ || ans);
                    const entities = qa.entities ? qa.entities[0].entity.map(e => ({ name: e.$.name, value: e.$.value })) : [];
                    const nextContext = qa.next_context ? (qa.next_context[0]._ || qa.next_context[0]).split(',').map(s => s.trim()) : [];

                    for (const q of questions) {
                        processedData.push({
                            question: (q._ || q).toLowerCase(), // Simpan pertanyaan dalam lowercase
                            intent: intentName,
                            threshold: threshold,
                            answers: answers,
                            entities: entities,
                            nextContext: nextContext
                        });
                    }
                }
            }
        }
        
        chatbotData = processedData;
        console.log(`Data berhasil dimuat. Total ${chatbotData.length} pola pertanyaan dari ${intents.length - 1} intent.`);

    } catch (error) {
        console.error('Gagal memuat atau memproses data.xml:', error);
        // Hentikan aplikasi jika data utama gagal dimuat
        process.exit(1);
    }
}

/**
 * Fungsi untuk mencatat query pengguna ke dalam log.json
 * @param {string} query - Pertanyaan dari pengguna.
 */
async function logQuery(query) {
    const logEntry = {
        query: query,
        timestamp: new Date().toISOString()
    };

    try {
        let logs = [];
        try {
            // Coba baca file log yang ada
            const data = await fs.readFile(LOG_JSON_PATH, 'utf8');
            logs = JSON.parse(data);
        } catch (readError) {
            // Jika file tidak ada, tidak apa-apa, kita akan membuatnya
            if (readError.code !== 'ENOENT') {
                throw readError;
            }
        }
        
        logs.push(logEntry);
        await fs.writeFile(LOG_JSON_PATH, JSON.stringify(logs, null, 2), 'utf8');

    } catch (error) {
        console.error('Gagal menulis ke log.json:', error);
    }
}

// Endpoint utama chatbot
app.get('/chat', async (req, res) => {
    const userQuery = req.query.q;

    if (!userQuery) {
        return res.status(400).json({ error: 'Parameter "q" (query) tidak boleh kosong, bro!' });
    }
    
    // 13. Mencatat input pengguna
    await logQuery(userQuery);

    // 7 & 14. Deteksi bahasa
    const languageDetector = new LanguageDetect();
    const detectedLangs = languageDetector.detect(userQuery, 1);
    const lang = detectedLangs.length > 0 ? detectedLangs[0][0] : 'unknown';

    // 19. Tokenizer
    const tokens = tokenizer.tokenize(userQuery.toLowerCase());

    let bestMatch = null;
    let bestScore = 1; // Fuse.js score: 0 is perfect match, 1 is no match

    // 3, 4, 15, 16. Pencarian intent dinamis dengan threshold berbeda
    const intents = [...new Set(chatbotData.map(item => item.intent))]; // Ambil semua nama intent unik
    
    for (const intentName of intents) {
        const itemsInIntent = chatbotData.filter(item => item.intent === intentName);
        const threshold = itemsInIntent[0].threshold; // Semua item dalam intent punya threshold yang sama

        const fuse = new Fuse(itemsInIntent, {
            keys: ['question'],
            includeScore: true,
            threshold: threshold,
            ignoreLocation: true,
        });

        const results = fuse.search(userQuery);

        if (results.length > 0 && results[0].score < bestScore) {
            bestScore = results[0].score;
            bestMatch = results[0].item;
        }
    }

    // Jika ada hasil yang cocok
    if (bestMatch) {
        // 9. Ambil jawaban acak
        const randomAnswer = bestMatch.answers[Math.floor(Math.random() * bestMatch.answers.length)];

        // 1, 5, 8, 10, 18. Siapkan respons
        return res.json({
            reply: randomAnswer,
            intent: bestMatch.intent,
            entities: bestMatch.entities, // Entity Recognition
            next_context: bestMatch.nextContext, // Konteks selanjutnya
            language: lang,
            tokens: tokens,
            confidence_score: (1 - bestScore).toFixed(4) // Ubah skor fuse menjadi skor kepercayaan (makin tinggi makin bagus)
        });
    } else {
        // Jika tidak ada yang cocok, gunakan fallback
        if (fallbackIntent) {
            const randomFallback = fallbackIntent.answers[Math.floor(Math.random() * fallbackIntent.answers.length)];
            return res.status(404).json({
                reply: randomFallback,
                intent: 'fallback',
                language: lang,
                tokens: tokens,
                confidence_score: 0
            });
        } else {
            // Fallback darurat jika intent fallback tidak terdefinisi di XML
            return res.status(404).json({
                error: 'Waduh, gue lagi bingung nih. Coba tanya yang lain, ya?',
                intent: 'unknown'
            });
        }
    }
});

// Endpoint untuk serve halaman depan sederhana
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Chatbot Gaul Lokal</title>
                <style>
                    body { font-family: sans-serif; background-color: #f0f0f0; text-align: center; padding-top: 50px; }
                    h1 { color: #333; }
                    p { color: #555; }
                    code { background-color: #eee; padding: 3px 6px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <h1>🤖 Chatbot Gaul Lokal Indonesia 🤖</h1>
                <p>Servernya udah jalan, bro! Coba panggil endpoint-nya, ya.</p>
                <p>Contoh: <code>/chat?q=siapa presiden indonesia sekarang</code></p>
            </body>
        </html>
    `);
});


// Jalankan server setelah data dimuat
const PORT = process.env.PORT || 3000;
loadChatbotData().then(() => {
    app.listen(PORT, () => {
        console.log(`Server chatbot gaul berjalan di http://localhost:${PORT}`);
    });
}).catch(error => {
    console.error("Gagal menjalankan server karena data tidak bisa dimuat.", error);
});

// Ekspor app untuk Vercel
module.exports = app;
