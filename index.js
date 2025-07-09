// index.js
// Mengimpor library yang dibutuhkan
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { parseStringPromise } = require('xml2js');
const Fuse = require('fuse.js');
const LanguageDetect = require('language-detect');
const natural = require('natural');
const mongoose = require('mongoose');
require('dotenv').config(); // Memuat environment variables dari file .env

// --- Inisialisasi Aplikasi Express ---
const app = express();
app.use(express.json()); // Middleware untuk parsing JSON body

// --- Konstanta dan Variabel Global ---
const DATA_XML_PATH = path.join(__dirname, 'data.xml');
let chatbotData = []; // Akan diisi dengan data dari XML setelah dimuat
let fallbackIntent = null; // Menyimpan intent fallback secara terpisah
const tokenizer = new natural.WordTokenizer(); // Inisialisasi tokenizer

// --- Konfigurasi dan Model Mongoose (Database) ---
// Skema untuk koleksi log. Ini adalah struktur data untuk setiap log di MongoDB.
const logSchema = new mongoose.Schema({
    query: {
        type: String,
        required: [true, 'Query tidak boleh kosong'],
        trim: true
    },
    intentDetected: {
        type: String,
        default: 'unknown'
    },
    language: {
        type: String,
        default: 'unknown'
    },
    confidenceScore: {
        type: Number,
        default: 0
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

// Membuat model dari skema. Model ini yang akan kita gunakan untuk berinteraksi dengan database.
const Log = mongoose.model('Log', logSchema);
// ----------------------------------------------------

/**
 * Memuat dan mem-parsing data.xml saat server pertama kali dijalankan.
 * Data diubah menjadi struktur array of objects agar mudah diproses oleh Fuse.js.
 */
async function loadChatbotData() {
    try {
        console.log('Membaca dan memproses data.xml...');
        const xmlData = await fs.readFile(DATA_XML_PATH, 'utf8');
        const parsedData = await parseStringPromise(xmlData);

        if (!parsedData.chatbot || !parsedData.chatbot.intent) {
            throw new Error("Struktur XML tidak valid. Tag <chatbot> atau <intent> tidak ditemukan.");
        }

        const intents = parsedData.chatbot.intent;
        let processedData = [];

        for (const intent of intents) {
            const intentName = intent.$.name;
            // Default threshold jika tidak didefinisikan di XML
            const threshold = parseFloat(intent.$.threshold || 0.4);

            // Menangani intent fallback secara khusus untuk efisiensi
            if (intentName === 'fallback') {
                fallbackIntent = {
                    name: intentName,
                    answers: intent.qa[0].answer.map(ans => ans._ || ans)
                };
                continue; // Lanjut ke intent berikutnya, tidak perlu dimasukkan ke data pencarian
            }

            if (intent.qa) {
                for (const qa of intent.qa) {
                    const questions = qa.question;
                    const answers = qa.answer.map(ans => ans._ || ans);
                    const entities = qa.entities ? qa.entities[0].entity.map(e => ({ name: e.$.name, value: e.$.value })) : [];
                    const nextContext = qa.next_context ? (qa.next_context[0]._ || qa.next_context[0]).split(',').map(s => s.trim()) : [];

                    for (const q of questions) {
                        // Defensive check untuk memastikan pertanyaan tidak kosong
                        if (q && (q._ || q)) {
                             processedData.push({
                                question: (q._ || q).toLowerCase(), // Simpan pertanyaan dalam lowercase untuk pencarian case-insensitive
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
        }
        
        chatbotData = processedData;
        console.log(`Data berhasil dimuat. Total ${chatbotData.length} pola pertanyaan dari ${intents.length - 1} intent aktif.`);

    } catch (error) {
        console.error('FATAL: Gagal memuat atau memproses data.xml:', error);
        // Hentikan aplikasi jika data utama gagal dimuat, karena bot tidak bisa berfungsi.
        process.exit(1);
    }
}

/**
 * Mencatat query pengguna ke dalam database MongoDB.
 * Fungsi ini sengaja dibuat "fire-and-forget" (tidak di-await di endpoint utama)
 * agar tidak memperlambat waktu respons chatbot ke pengguna.
 * @param {object} logData - Objek berisi data log yang akan disimpan.
 */
async function logQueryToDB(logData) {
    try {
        const newLog = new Log(logData);
        await newLog.save();
    } catch (error) {
        // Kesalahan logging tidak boleh menghentikan aplikasi, cukup catat di konsol.
        console.error('Gagal menyimpan log ke MongoDB:', error.message);
    }
}

// --- Endpoint Utama Chatbot ---
app.get('/chat', async (req, res) => {
    const userQuery = req.query.q;

    if (!userQuery || userQuery.trim() === '') {
        return res.status(400).json({ 
            error: true, 
            message: 'Parameter "q" (query) tidak boleh kosong, bro!' 
        });
    }
    
    // 1. Analisis Input Pengguna
    const languageDetector = new LanguageDetect();
    const detectedLangs = languageDetector.detect(userQuery, 1);
    const lang = detectedLangs.length > 0 ? detectedLangs[0][0] : 'unknown';
    const tokens = tokenizer.tokenize(userQuery.toLowerCase());

    // 2. Pencarian Intent
    let bestMatch = null;
    let bestScore = 1; // Skor Fuse.js: 0 = sempurna, 1 = tidak cocok

    // Loop melalui setiap intent unik untuk menerapkan threshold yang berbeda
    const uniqueIntents = [...new Set(chatbotData.map(item => item.intent))]; 
    for (const intentName of uniqueIntents) {
        const itemsInIntent = chatbotData.filter(item => item.intent === intentName);
        const threshold = itemsInIntent[0].threshold; // Semua item dalam satu intent punya threshold yang sama

        const fuse = new Fuse(itemsInIntent, {
            keys: ['question'],
            includeScore: true,
            threshold: threshold,
            ignoreLocation: true,
        });

        const results = fuse.search(userQuery);

        // Jika ditemukan hasil yang lebih baik dari sebelumnya
        if (results.length > 0 && results[0].score < bestScore) {
            bestScore = results[0].score;
            bestMatch = results[0].item;
        }
    }

    // 3. Membentuk dan Mengirim Respons
    if (bestMatch) {
        const confidenceScore = (1 - bestScore);
        const randomAnswer = bestMatch.answers[Math.floor(Math.random() * bestMatch.answers.length)];

        // Kirim respons ke pengguna
        res.json({
            reply: randomAnswer,
            intent: bestMatch.intent,
            entities: bestMatch.entities,
            next_context: bestMatch.nextContext,
            language: lang,
            confidence_score: parseFloat(confidenceScore.toFixed(4))
        });

        // Catat ke database (fire-and-forget)
        logQueryToDB({ query: userQuery, intentDetected: bestMatch.intent, language: lang, confidenceScore: confidenceScore });

    } else {
        // Jika tidak ada intent yang cocok, gunakan fallback
        const fallbackReply = fallbackIntent 
            ? fallbackIntent.answers[Math.floor(Math.random() * fallbackIntent.answers.length)]
            : 'Waduh, gue lagi bingung nih. Coba tanya yang lain, ya?';
        
        res.status(404).json({
            reply: fallbackReply,
            intent: 'fallback',
            language: lang,
            confidence_score: 0
        });

        // Catat juga fallback ke database
        logQueryToDB({ query: userQuery, intentDetected: 'fallback', language: lang, confidenceScore: 0 });
    }
});

// --- Endpoint Tambahan ---
// Halaman utama untuk verifikasi server berjalan
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Chatbot Gaul Lokal</title></head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h1>🤖 Chatbot Gaul Lokal Indonesia 🤖</h1>
                <p>Servernya udah jalan dan terhubung ke MongoDB, bro!</p>
                <p>Contoh: <code>/chat?q=siapa presiden indonesia sekarang</code></p>
            </body>
        </html>
    `);
});

// --- Proses Startup Server ---
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('FATAL: MONGODB_URI tidak ditemukan di environment variables. Harap buat file .env dan definisikan variabel tersebut.');
    process.exit(1);
}

// Urutan startup: 1. Hubungkan DB -> 2. Muat data XML -> 3. Jalankan server Express
console.log('Menghubungkan ke MongoDB...');
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('Berhasil terhubung ke MongoDB.');
        return loadChatbotData(); // Lanjutkan memuat data dari XML
    })
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server chatbot gaul berjalan di http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('FATAL: Terjadi kesalahan saat proses startup server:', err);
        process.exit(1);
    });

// Ekspor app untuk kompatibilitas dengan Vercel
module.exports = app;
