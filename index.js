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
// Fallire subito con un messaggio chiaro invece di crashare a metà esecuzione
// con errori criptici (es. richieste a ntfy.sh/undefined).
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
      console.warn(`⚠️ Impossibile eliminare ${target}: ${err.message}`);
    }
  }
}

// ── Creazione e attesa client WhatsApp ────────────────────────────────────────
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
        type: 'local'
      },
      puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--js-flags=--max-old-space-size=1024',
        ],
        timeout: 60_000,
      },
    });

    const readyPromise = new Promise((resolve, reject) => {

      // Guard: garantisce che reject venga chiamata una sola volta anche se
      // più eventi di errore arrivano in sovrapposizione (es. 'disconnected'
      // e browserTimer che scattano insieme).
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
        // clearTimeout su entrambi: il QR ruota ogni ~20s e senza cancellazione
        // si accumulano timer orfani che scattano in momenti inattesi.
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

      // FIX TargetCloseError: intercetta la disconnessione inaspettata di Chromium
      // che avviene durante l'injection di whatsapp-web.js.
      // Senza questo listener la Promise resterebbe appesa per tutti i 3 minuti
      // del browserTimer invece di ritentare immediatamente.
      client.on('disconnected', (reason) => {
        console.error(`💥 Chromium disconnesso durante l'avvio: ${reason}`);
        fail(`Chromium disconnesso inaspettatamente: ${reason}`);
      });
    });

    await cleanSessionCache();
    await client.initialize();

    // Aggancia i listener Puppeteer sulla pagina interna DOPO initialize(),
    // unico momento in cui client.pupPage esiste già.
    // 'error'     = crash del processo renderer (es. OOM, segfault)
    // 'pageerror' = eccezione JS non catturata dentro WhatsApp Web (raramente
    //               fatale, ma la logghiamo per diagnostica)
    const page = client.pupPage;
    if (page) {
      page.on('error', (err) => {
        console.error(`💥 Crash renderer Puppeteer: ${err.message}`);
        // Nota: a questo punto 'disconnected' è già stato emesso dal client,
        // quindi hasFailed è già true e fail() uscirà silenziosamente.
        // Il listener serve come safety net per i casi in cui 'disconnected'
        // non venisse emesso (es. kill -9 sul processo Chromium).
        if (!hasFailed) {
          hasFailed = true;
          cleanup().then(() => {});
        }
      });

      page.on('pageerror', (err) => {
        // Errore JS interno a WhatsApp Web — non sempre fatale, logghiamo
        // solo per avere visibilità in caso di debug futuro.
        console.warn(`⚠️ Errore JS in pagina WhatsApp Web: ${err.message}`);
      });
    }

    return await readyPromise;

  } catch (err) {
    await cleanup();
    throw err;
  }
}

// ── Loop principale con retry e backoff esponenziale ──────────────────────────
async function run() {
  
  const dataAvvio = new Date();
  const dataFormattata = dataAvvio.toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  console.log(`==================================================`);
  console.log(`🚀 Script avviato il: ${dataFormattata}`);
  console.log(`==================================================`);
  
  validateEnv();

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n⏳ Tentativo ${attempt}/${MAX_RETRIES}…`);

    // Definiamo il client qui fuori per poterlo chiudere nel finally principale
    let client = null; 

    try {
      // 1. Avvia e attendi WhatsApp
      client = await createAndWaitReady(attempt);

      // 2. Esegui il controllo degli eventi (Google Calendar)
      // Se questo fallisce, lancia un errore che viene catturato dal catch esterno,
      // permettendo al ciclo FOR di passare al tentativo successivo.
      await checkeEvents(client);

      // 3. Se tutto è andato a buon fine (WhatsApp + Google), chiudiamo in modo pulito ed usciamo con 0
      try {
        console.log('⏳ Chiusura del client WhatsApp in corso...');
        await new Promise((r) => setTimeout(r, 5000)); 
        await client.destroy(); 
        console.log('👋 Client disconnesso pulitamente.'); 
      } catch (_) {}

      process.exit(0);

    } catch (err) {
      lastError = err;
      console.error(`❌ Tentativo ${attempt} fallito: ${err.message}`);

      // Garantiamo la chiusura del client WhatsApp ad ogni tentativo fallito,
      // altrimenti i processi Chromium rimangono appesi in background ad ogni retry!
      if (client) {
        try {
          console.log('⏳ Pulizia client WhatsApp dopo il fallimento...');
          await client.destroy();
        } catch (_) {}
      }

      // Se non abbiamo esaurito i tentativi, aspettiamo il backoff ed eseguiamo il prossimo loop
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1); // 30s, 60s, 120s
        console.log(`🔄 Prossimo tentativo tra ${delay / 1000}s…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // Se arriviamo qui, significa che TUTTI i tentativi (1, 2 e 3) sono falliti
  console.error(`💀 Bot arrestato dopo ${MAX_RETRIES} tentativi falliti.`);
  await sendNtfySummary(
    `💀 Bot WhatsApp/Calendar non riuscito dopo ${MAX_RETRIES} tentativi.\n\nUltimo errore: ${lastError?.message}\n\nIntervento manuale necessario.`,
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

    // 1. Controlliamo SUBITO se è un evento di tutto il giorno
    if (!event.start.dateTime) {
      reportDetails.push(`⏭️ ${clientName}: evento tutto il giorno, reminder non inviato`);
      continue;
    }

    // 2. Estraiamo date e orari
    const startdate = new Date(event.start.dateTime);
    const apptime   = startdate.toLocaleTimeString('it-IT', { timeStyle: 'short', timeZone: 'Europe/Rome' });
    const appdate   = startdate.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    const chatId    = number_tel;

    let eventDescription = event.description || '';
   
    // 3. Creiamo il tag dinamico per la data corrente (es: [REMINDER_SENT_12/06/2026])
    const reminderTag = `[REMINDER_SENT_${appdate}]`;

    // 4. Verifichiamo se il tag SPECIFICO di oggi esiste già
    if (eventDescription.includes(reminderTag)) {
      reportDetails.push(`⏭️ ${clientName}: reminder già inviato per questa data`);
      continue;
    }

    // 5. PULIZIA DEI VECCHI TAG COPIATI
    // Questa regex cerca la scritta "[REMINDER_SENT_..." seguita da qualsiasi data e chiusa da "]"
    // Il flag 'g' rimuove TUTTI i vecchi tag se ce n'è più di uno, e .trim() pulisce gli spazi vuoti.
    const oldTagsRegex = /\[REMINDER_SENT_\d{2}\/\d{2}\/\d{4}\]/g;
    eventDescription = eventDescription.replace(oldTagsRegex, '').trim();

    try {
      await sendReminder(client, chatId, generateReminder(appdate, apptime));
      successCount++;

      try {
        // 6. Costruiamo la nuova descrizione: se è rimasto del testo (le note reali dell'appuntamento),
        // andiamo a capo e mettiamo il nuovo tag, altrimenti mettiamo solo il tag.
        const updatedDescription = eventDescription
          ? `${eventDescription}\n${reminderTag}`
          : reminderTag;

        await calendar.events.patch({
          calendarId: process.env.CALENDAR_ID,
          eventId: event.id,
          requestBody: { description: updatedDescription },
        });
        reportDetails.push(`✅ ${apptime} — ${clientName}`);
      } catch (patchErr) {
        console.warn(`⚠️ Messaggio inviato ma tag non scritto per ${clientName}: ${patchErr.message}`);
        reportDetails.push(`✅⚠️ ${apptime} — ${clientName} (inviato, tag Calendar fallito: verificare manualmente)`);
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

async function sendReminder(client, chatId, text) {
  let cleanNumber = chatId.replace(/[^0-9]/g, '');

  // Rimuove il doppio zero iniziale (es. 0039 → 39)
  if (cleanNumber.startsWith('00')) {
    cleanNumber = cleanNumber.slice(2);
  }

  // Aggiunge il prefisso italiano se mancante
  if (cleanNumber.length === 10 && cleanNumber.startsWith('3')) {
    cleanNumber = '39' + cleanNumber;
  }

  if (!cleanNumber || cleanNumber.length < 11) {
    throw Object.assign(new Error(`Numero non valido: "${chatId}"`), {
      name: 'NotPresentError',
    });
  }

  try {
    const numberDetails = await client.getNumberId(cleanNumber);

    if (!numberDetails || !numberDetails._serialized) {
      throw Object.assign(new Error('Numero non registrato su WhatsApp'), {
        name: 'NotPresentError',
      });
    }

    const result = await client.sendMessage(numberDetails._serialized, text);
    console.log(`✅ Messaggio inviato a ${cleanNumber}`);
    return result;

  } catch (err) {
    if (err.name === 'NotPresentError') throw err;
    throw new Error(`Errore durante l'invio a ${cleanNumber}: ${err.message}`);
  }
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
