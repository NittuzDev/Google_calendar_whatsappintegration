import { google } from 'googleapis';
import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import pkg from 'whatsapp-web.js';
import 'dotenv/config';
import qrcode from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

// ── Costanti ──────────────────────────────────────────────────────────────────
const MAX_RETRIES        = 3;
const BROWSER_TIMEOUT_MS = 3 * 60 * 1000; // 3 min: tempo max per avviare il browser
const QR_TIMEOUT_MS      = 2 * 60 * 1000; // 2 min extra se arriva il QR (nessuno scansiona)
const BACKOFF_BASE_MS    = 30_000;         // backoff esponenziale: 30s → 60s → 120s

// ── Validazione variabili d'ambiente ─────────────────────────────────────────
// FIX 3: Fallire subito con un messaggio chiaro invece di crashare a metà
// esecuzione con errori criptici (es. ntfy.sh/undefined).
function validateEnv() {
  const required = ['CALENDAR_ID', 'NTFY_TOPIC_ADMIN', 'NTFY_TOPIC_ROBY'];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ Variabili d'ambiente mancanti: ${missing.join(', ')}`);
    console.error('Controlla il file .env e riavvia.');
    process.exit(1);
  }
}

// ── Auth Google Calendar ───────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(process.cwd(), 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

// ── Pulizia cache Chromium ────────────────────────────────────────────────────
// Elimina solo le cartelle di cache transitoria, mai i dati di login (IndexedDB,
// Local Storage, Cookies) che risiedono un livello sopra.
// Chiamare prima di ogni client.initialize() per evitare loop di caricamento
// causati da cache corrotta dopo un crash precedente.
async function cleanSessionCache() {
  const targets = [
    './sessions/session-client-one/Default/Service Worker',
    './sessions/session-client-one/Default/Cache',
    './sessions/session-client-one/Default/Code Cache',
    './sessions/session-client-one/Default/GPUCache',
  ];

  for (const target of targets) {
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`🧹 Cache eliminata: ${target}`);
      }
    } catch (err) {
      // Non blocchiamo l'avvio se la pulizia fallisce: logghiamo e andiamo avanti
      console.warn(`⚠️ Impossibile eliminare ${target}: ${err.message}`);
    }
  }
}

// ── Creazione e attesa client WhatsApp ────────────────────────────────────────
// FIX 1: Riscritta come funzione async normale invece di new Promise(async ...)
// per evitare eccezioni silenziosamente inghiottite che lasciano la Promise appesa.
// FIX 2: Guard booleano hasFailed per evitare doppi reject (es. auth_failure +
// timeout in contemporanea che chiamano fail() due volte).
async function createAndWaitReady(attempt) {
  let hasNotified  = false;
  let hasFailed    = false;
  let browserTimer = null;
  let qrTimer      = null;
  let client       = null;

  const cleanup = async () => {
    clearTimeout(browserTimer);
    clearTimeout(qrTimer);
    if (client) {
      try { await client.destroy(); } catch (_) {}
    }
  };

  try {
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'client-one',
        dataPath: './sessions',
      }),
      webVersionCache: {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1039391386-alpha.html',
      },
      puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // RIMOSSO --single-process: causava processi zombie e lock file
          // appesi in ./sessions su Linux, miccia principale dei timeout.
          '--no-zygote',
          '--disable-gpu',
        ],
        timeout: 60_000,
      },
    });

    // Wrappa i listener in una Promise gestita correttamente
    const readyPromise = new Promise((resolve, reject) => {

      // Helper fail con guard: garantisce che reject venga chiamata una sola volta
      // anche se più eventi di errore arrivano in sovrapposizione.
      const fail = async (reason) => {
        if (hasFailed) return;
        hasFailed = true;
        await cleanup();
        reject(new Error(reason));
      };

      // Timer principale: scatta se Chromium non si avvia entro BROWSER_TIMEOUT_MS
      browserTimer = setTimeout(() => {
        fail(`Timeout avvio browser (tentativo ${attempt}/${MAX_RETRIES})`);
      }, BROWSER_TIMEOUT_MS);

      // ── Listeners ────────────────────────────────────────────────────────────

      client.on('qr', (qr) => {
        // FIX 7: Azzerare qrTimer prima di ricrearlo — il QR ruota ogni ~20s
        // e senza clearTimeout si accumulano timer orfani in memoria.
        clearTimeout(browserTimer);
        clearTimeout(qrTimer);
        qrcode.generate(qr, { small: true });

        if (!hasNotified) {
          hasNotified = true;
          sendNtfySummary(
            `⚠️ Sessione WhatsApp scaduta (tentativo ${attempt}/${MAX_RETRIES}).\nScansiona il QR dal terminale entro 2 minuti.`,
            'Softique Admin',
            process.env.NTFY_TOPIC_ADMIN,
            'high',
            'warning',
          );
        }

        // Se nessuno scansiona entro QR_TIMEOUT_MS, abbandoniamo il tentativo
        qrTimer = setTimeout(() => {
          fail(`QR non scansionato entro il timeout (tentativo ${attempt}/${MAX_RETRIES})`);
        }, QR_TIMEOUT_MS);
      });

      client.on('ready', () => {
        clearTimeout(browserTimer);
        clearTimeout(qrTimer);
        console.log(`✅ Client WhatsApp pronto (tentativo ${attempt}/${MAX_RETRIES})`);
        resolve(client);
      });

      client.on('auth_failure', async (msg) => {
        await sendNtfySummary(
          `⚠️ Auth WhatsApp fallita (tentativo ${attempt}/${MAX_RETRIES}).\n\nErrore: ${msg}\n\nCancella ./sessions e riscansiona il QR.`,
          'Softique Admin',
          process.env.NTFY_TOPIC_ADMIN,
          'high',
          'warning',
        );
        fail(`Auth failure: ${msg}`);
      });
    });

    await cleanSessionCache();   // pulizia cache prima di ogni tentativo
    await client.initialize();   // avvia Chromium (non-blocking: i listener gestiscono il resto)
    return await readyPromise;   // attende 'ready' o il primo errore

  } catch (err) {
    // initialize() stesso può lanciare (es. Chromium non trovato sul PATH)
    await cleanup();
    throw err; // rilancia per il loop di retry in run()
  }
}

// ── Loop principale con retry e backoff esponenziale ──────────────────────────
async function run() {
  validateEnv(); // FIX 3: validazione anticipata delle env var

  let lastError;
  let eventsError = false; // FIX 4: traccia se l'errore è avvenuto in checkeEvents

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n⏳ Tentativo ${attempt}/${MAX_RETRIES}…`);

    try {
      const client = await createAndWaitReady(attempt);

      try {
        await checkeEvents(client);
      } catch (err) {
        eventsError = true;
        console.error('❌ Errore in checkeEvents:', err);
        await sendNtfySummary(
          `❌ Errore critico durante il check degli eventi!\n\n${err.message}`,
          'Softique Admin',
          process.env.NTFY_TOPIC_ADMIN,
          'high',
          'warning',
        );
      } finally {
        // await esplicito: Chromium chiude i file descriptor prima di exit
        try { await client.destroy(); } catch (_) {}
      }

      // FIX 4: Se checkeEvents ha lanciato, usciamo con codice 1 (errore),
      // non con 0 (successo) come faceva prima.
      process.exit(eventsError ? 1 : 0);

    } catch (err) {
      lastError = err;
      console.error(`❌ Tentativo ${attempt} fallito: ${err.message}`);

      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1); // 30s, 60s, 120s
        console.log(`🔄 Prossimo tentativo tra ${delay / 1000}s…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // Tutti i tentativi esauriti
  console.error(`💀 Bot arrestato dopo ${MAX_RETRIES} tentativi falliti.`);
  await sendNtfySummary(
    `💀 Bot WhatsApp non riuscito dopo ${MAX_RETRIES} tentativi.\n\nUltimo errore: ${lastError?.message}\n\nIntervento manuale necessario.`,
    'Softique Admin',
    process.env.NTFY_TOPIC_ADMIN,
    'high',
    'warning',
  );
  process.exit(1);
}

// ── Check eventi Google Calendar ──────────────────────────────────────────────
async function checkeEvents(client) {
  const reportDetails = [];
  let successCount    = 0;

  const authClient = await auth.getClient();
  const calendar   = google.calendar({ version: 'v3', auth: authClient });

  const now = new Date();

  const tomorrow_morning = new Date(now);
  tomorrow_morning.setDate(now.getDate() + 1);
  tomorrow_morning.setHours(0, 0, 0, 0);

  const tomorrow_evening = new Date(now);
  tomorrow_evening.setDate(now.getDate() + 1);
  tomorrow_evening.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId: process.env.CALENDAR_ID,
    timeMin: tomorrow_morning.toISOString(),
    timeMax: tomorrow_evening.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items;

  if (!events || events.length === 0) {
    console.log('📭 Nessun evento per domani.');
    await sendNtfySummary(
      '\n\nCiao Roby!\n\nPer domani non hai appuntamenti programmati, non ho inviato nessun reminder.\n\nBuona giornata! 📭',
      'Softique Beauty Nail',
      process.env.NTFY_TOPIC_ROBY,
      'default',
      'memo,nail_care',
    );
    return;
  }

  for (const event of events) {
    const number_tel = event.location;
    const clientName = event.summary || 'Cliente';

    console.log(`\n📅 Lavorazione: ${clientName} — ${number_tel ?? 'numero mancante'}`);

    if (!number_tel) {
      reportDetails.push(`❌ ${clientName}: numero di telefono mancante nel campo "Luogo"`);
      continue;
    }

    const eventDescription = event.description || '';

    if (eventDescription.includes('[REMINDER_SENT]')) {
      reportDetails.push(`⏭️ ${clientName}: reminder già inviato`);
      continue;
    }

    if (!event.start.dateTime) {
      reportDetails.push(`⏭️ ${clientName}: evento tutto il giorno, reminder non inviato`);
      continue;
    }

    const startdate = new Date(event.start.dateTime);
    const apptime   = startdate.toLocaleTimeString('it-IT', { timeStyle: 'short', timeZone: 'Europe/Rome' });
    const appdate   = startdate.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    const chatId    = number_tel.replace('+', '').trim() + '@c.us';

    try {
      await sendReminder(client, chatId, generateReminder(appdate, apptime));
      successCount++;

      // FIX 5: Il patch viene tentato subito dopo l'invio. Se fallisce,
      // logghiamo il problema nel report ma non perdiamo il conteggio del
      // messaggio inviato — l'operatore vedrà l'avviso nel riepilogo ntfy
      // e potrà verificare manualmente. Un reminder inviato senza tag è
      // preferibile a non registrare l'invio e lasciare il campo ambiguo.
      try {
        await calendar.events.patch({
          calendarId: process.env.CALENDAR_ID,
          eventId: event.id,
          requestBody: { description: eventDescription + '\n[REMINDER_SENT]' },
        });
        reportDetails.push(`✅ ${apptime} — ${clientName}`);
      } catch (patchErr) {
        console.warn(`⚠️ Messaggio inviato ma tag non scritto per ${clientName}: ${patchErr.message}`);
        reportDetails.push(`✅⚠️ ${apptime} — ${clientName} (inviato, tag fallito: verificare manualmente)`);
      }

      // Delay casuale tra messaggi (2–5s) per comportamento più naturale
      const delay = 2000 + Math.random() * 3000;
      await new Promise((r) => setTimeout(r, delay));

    } catch (err) {
      console.error(`❌ Errore invio a ${clientName}:`, err.message);
      reportDetails.push(`❌ ${apptime} — ${clientName}: ${err.message}`);
    }
  }

  const summaryMessage =
    `Appuntamenti di domani\n\nReminder inviati: ${successCount}/${events.length}\n\n` +
    reportDetails.join('\n');

  await sendNtfySummary(
    summaryMessage,
    'Softique Beauty Nail',
    process.env.NTFY_TOPIC_ROBY,
    'default',
    'memo,nail_care',
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateReminder(date, time) {
  return (
    `💅💅 *Softique Beauty Nail* 💅💅\n\n` +
    `*Promemoria appuntamento*\n\n` +
    `Le ricordiamo il suo appuntamento:\n` +
    `🗓️ ${date}\n` +
    `⏰️ ${time}\n\n` +
    `Presso: Estetica Samsara, via Antonio Magri 3/A Rovetta (BG)\n\n` +
    `Messaggio generato automaticamente`
  );
}

// FIX 6: Lanciare una vera Error con stack trace invece di un oggetto literal
// { name, message } che non viene catturato correttamente da tutti gli handler.
async function sendReminder(client, chatId, text) {
  const numberDetails = await client.getNumberId(chatId);
  if (!numberDetails?._serialized) {
    throw Object.assign(new Error('Numero non registrato su WhatsApp'), {
      name: 'NotPresentError',
    });
  }
  const result = await client.sendMessage(numberDetails._serialized, text);
  console.log(`✅ Messaggio inviato a ${chatId}`);
  return result;
}

async function sendNtfySummary(message, title, topic, priority, tags) {
  try {
    await axios.post(`https://ntfy.sh/${topic}`, message, {
      headers: { Title: title, Priority: priority, Tags: tags },
    });
    console.log(`📲 Notifica ntfy inviata — ${title}`);
  } catch (err) {
    console.error('❌ Errore invio ntfy:', err.message);
  }
}

// ── Avvio ─────────────────────────────────────────────────────────────────────
run();
