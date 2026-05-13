import { google } from 'googleapis';
import path from 'node:path';
import axios from 'axios';
import pkg from 'whatsapp-web.js';
import 'dotenv/config';
import qrcode from 'qrcode-terminal'; // FIX 1: Standard import

const { Client, LocalAuth } = pkg;


// 1. Setup Auth
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(process.cwd(), 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

// --- NTFY NOTIFICATION LOGIC ---
let hasNotified = false; // Flag to prevent spam


// --- WHATSAPP CLIENT SETUP ---

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "client-one", // Best practice: use a specific ID
        dataPath: './sessions'  // Use a relative path
    }),
    // FIX 2: Add puppeteer args to ensure the browser launches correctly
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Aiuta a gestire meglio i file su Windows
        ],
    }
});

client.on('ready', async () => {
    clearTimeout(initTimeout);
    console.log('✅ Client is ready!');
    hasNotified = false; 
    try {
        await checkeEvents();
    } finally {
        await client.destroy().catch(() => {});
        process.exit(0);
    }
});

// Listener for the QR code

client.on('qr', (qr) => {
  console.log('QR RECEIVED: Generating in terminal');
  qrcode.generate(qr, { small: true }); // Still prints to shell for backup
 
  // Send the push notification (only once)
  
  if(!hasNotified)
  {
    sendNtfySummary("⚠️ La sessione di whatsapp è scaduta! Accedi al terminale per scansionare il QR code","Softique Admin",process.env.NTFY_TOPIC_ADMIN,"high",'warning');
    hasNotified = true;
  }

});

function generateReminder(date, time) {
  return `💅💅 *Softique Beauty Nail* 💅💅\n\n*Promemoria appuntamento*\n\nLe ricordiamo il suo appuntamento:\n🗓️ ${date} \n⏰️ ${time} \n\nPresso: Estetica Samsara, via Antonio Magri 3/A Rovetta (BG)\n\nMessaggio generato automaticamente`;
}

// -- FUNCTION FOR SEND WHATSAPP REMINDERS
// Nella funzione send_reminder, assicurati di attendere l'invio
async function send_reminder(chatId, text) {
    try {
        const number_details = await client.getNumberId(chatId);
        if (number_details && number_details._serialized) {
            // È fondamentale l'await qui
            const sendMessageData = await client.sendMessage(number_details._serialized, text);
            console.log(`✅ Messaggio inviato a ${chatId}`);
            return sendMessageData;
        } else {
            throw {name : "NotPresentError", message : "Il numero non è registrato"}; 
        }
    } catch (error) {
        console.error("Errore invio:", error.message);
        throw error; // Rilancia l'errore per gestirlo nel report
    }
}


async function checkeEvents() {
  let reportDetails = [];
  let successCount = 0;

  try {
      const authClient = await auth.getClient();
      const calendar = google.calendar({ version: 'v3', auth: authClient });

      const now = new Date();
      const tomorrow_morning = new Date(now);
      tomorrow_morning.setDate(now.getDate() + 1);
      tomorrow_morning.setHours(0, 0, 0, 0);

      const tomorrow_evening = new Date(now);
      tomorrow_evening.setDate(now.getDate() + 1);
      tomorrow_evening.setHours(23, 59, 59, 99);

      const response = await calendar.events.list({
        calendarId: process.env.CALENDAR_ID,
        timeMin: tomorrow_morning.toISOString(),
        timeMax: tomorrow_evening.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items;

      if (!events || events.length === 0) {
        console.log("No events planne for tomorrow");
        await sendNtfySummary("\n\nCiao Roby!\n\nPer domani non hai appuntamenti programmati quindi non ho mandato nessun reminder.\n\nBuona giornata! 📭","Softique Beauty Nail", process.env.NTFY_TOPIC_ROBY,"default","memo,nail_care");
        return;
      }

      // MODIFICA: Usiamo un ciclo for...of per inviare i messaggi uno alla volta
      for (const event of events) {


        console.log("\nLavorazione evento "+event.summary+" - "+event.location+"\n");

        const number_tel = event.location;
        const clientName = event.summary || "Cliente";

        //numero di telefono mancante
        if (!number_tel) {
          reportDetails.push(`❌ ${clientName}: Numero di telefono mancante`);
          console.log("Numero di telefono mancante - skip\n");
          continue; // Passa al prossimo evento
        }

        const eventDescription = event.description || "";

        if (eventDescription.includes("[REMINDER_SENT]")) {
            console.log("Reminder già inviato - skip\n");
            reportDetails.push(`❌ ${clientName}: Reminder già inviato`);
            continue; 
        }

        if (!event.start.dateTime) {
            console.log("Evento tutto il giorno - skip\n");
            reportDetails.push(`⏭️ ${clientName}: Evento tutto il giorno, reminder non inviato`);
            continue;
        }

        const startdate = new Date(event.start.dateTime);

        const apptime = startdate.toLocaleTimeString('it-IT', { 
            timeStyle: 'short', 
            timeZone: 'Europe/Rome' 
        });
        const appdate = startdate.toLocaleDateString('it-IT', { 
            timeZone: 'Europe/Rome' 
        });

        const chatId = number_tel.replace('+', '').trim() + "@c.us";

        try {
          // Aspetta che l'invio sia completato prima di passare al prossimo
          await send_reminder(chatId, generateReminder(appdate, apptime));
          successCount++;
          reportDetails.push(`✅ ${apptime} - ${clientName}`);
          

          // Inserisco il TAG per l invio
          await calendar.events.patch({
                calendarId: process.env.CALENDAR_ID,
                eventId: event.id,
                requestBody: {
                description: "[REMINDER_SENT]",
                },
            }); 

          // Piccolo delay di cortesia tra un messaggio e l'altro (opzionale ma consigliato)
          // ✅ Tra 2 e 5 secondi
          const delay = 2000 + Math.random() * 3000;
          await new Promise(resolve => setTimeout(resolve, delay));
          
        } catch (err) {
          console.error(`Errore invio a ${clientName}:`, err.message);
          reportDetails.push(`❌ ${apptime} - ${clientName} - ${err.message}`);
        }
      }

      const summaryMessage = `Appuntamenti di domani\n\nReminder inviati: ${successCount}/${events.length}\n\n` + reportDetails.join('\n');
      await sendNtfySummary(summaryMessage,"Softique Beauty Nail",process.env.NTFY_TOPIC_ROBY,"default","memo,nail_care");

  } catch (error) {
    console.error('❌ Error:', error);
    await sendNtfySummary("Errore critico durante il check degli eventi!","Softique Admin",process.env.NTFY_TOPIC_ADMIN,"high",'warning');
  } 
}

async function sendNtfySummary(message, title, topic, priority, tags) {
    try {
        await axios.post(`https://ntfy.sh/${topic}`, 
            message, 
            {
                headers: {
                    'Title': title,
                    'Priority': priority,
                    'Tags': tags
                }
            }
        );
        console.log(`📲 Inviata comunicazione ntfy - ${title}`);
    } catch (error) {
        console.error('❌ Errore invio ntfy summary:', error.message);
    }
}

console.log("⏳ Initializing WhatsApp...");

const INIT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minuti

const initTimeout = setTimeout(async () => {
    console.error('⏱️ Timeout: client non pronto, uscita forzata.');
    await sendNtfySummary(
        '⚠️ Timeout avvio WhatsApp: sessione probabilmente scaduta.',
        'Softique Admin',
        process.env.NTFY_TOPIC_ADMIN,
        'high',
        'warning'
    );
    await client.destroy().catch(() => {});
    process.exit(1);
}, INIT_TIMEOUT_MS);

await client.initialize();
