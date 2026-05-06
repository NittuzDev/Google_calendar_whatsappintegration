import { google } from 'googleapis';
import path from 'node:path';

// 1. Setup Auth
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(process.cwd(), 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
});



// setup client for whatsapp server

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal'; // FIX 1: Standard import
const { Client, LocalAuth } = pkg;

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "client-one", // Best practice: use a specific ID
        dataPath: './sessions'  // Use a relative path
    }),
    // FIX 2: Add puppeteer args to ensure the browser launches correctly
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('ready', () => {
    console.log('✅ Client is ready!');;
    checkeEvents();
});

function generateReminder(date, time) {
  return `💅💅 *Softique Beauty Nail* 💅💅\n\n*Promemoria appuntamento*\n\nLe ricordiamo il suo appuntamento:\n🗓️ ${date} \n⏰️ ${time} \n\nPresso: Estetica Samsara, via Antonio Magri 3/A Rovetta (BG)\n\nMessaggio generato automaticamente`;
}


async function send_reminder(chatId, text) {

    try {

        console.log(chatId);
        const number_details = await client.getNumberId(chatId);
        
        console.log(number_details);

        const contact_info = await client.getContactById(chatId)
        

        if (number_details && number_details._serialized) {

            //const sendMessageData = await client.sendMessage(number_details._serialized, text);

            console.log("Messaggio inviato con successo!");
            return sendMessageData;
        } else {
            console.log(chatId, "Il numero non è registrato su WhatsApp");
        }
    } catch (error) {
        // Questo cattura l'errore che causa il triggerUncaughtException
        console.error("Errore durante l'invio del messaggio:", error.message);
    }
}


async function checkeEvents() {
  try {
    const authClient = await auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const now = new Date();


    const tomorrow_morning = new Date(now);
    tomorrow_morning.setDate(now.getDate() + 1);
    tomorrow_morning.setHours(1, 0, 0, 0);


    // Create a new date for tomorrow
    const tomorrow_evening = new Date(now);
    tomorrow_evening.setDate(now.getDate() + 1);

    // Set time to 23:59:00.000
    tomorrow_evening.setHours(23, 59, 0, 0);


    // 2. Fetch Events
    const response = await calendar.events.list({
      calendarId: 'softique.beauty.nail@gmail.com', // This refers to the service account's own calendar
                             // or the one you shared with its email.
      timeMin: tomorrow_morning.toISOString(),
      timeMax: tomorrow_evening.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items;

    if (!events || events.length === 0) {
      console.log('No upcoming events found.');
      return;
    }

    console.log('Upcoming events for tomorrow:');
    events.forEach((event) => {
      
      var number_tel=event.location;
      var startdtime=event.start.dateTime

      var startdate=new Date(startdtime)
      var appdate = startdate.toLocaleDateString();

      var apptime = startdate.toLocaleTimeString('it-IT', {
          timeStyle: 'short',
          hour12: false
      });


        // Number where you want to send the message.
        const number = number_tel;

        // Your message.
        
        // Getting chatId from the number.
        // we have to delete "+" from the beginning and add "@c.us" at the end of the number.
        const chatId = number + "@c.us";
        send_reminder (chatId, generateReminder(appdate, apptime));

    });

    
    
  } catch (error) {
    console.error('Error fetching calendar events:', error);
  } finally {

          await Promise.all(eventPromises); // You'd need to map events to promises first
          console.log("All reminders processed. Shutting down...");
          await client.destroy(); 
          process.exit(0);

  }
}

// Listener for the QR code
client.on('qr', (qr) => {
    console.log('QR RECEIVED:');
    qrcode.generate(qr, { small: true });
});


console.log("⏳ Initializing WhatsApp...");
await client.initialize();
