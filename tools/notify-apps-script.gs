// Sends the quiz's notifications (cancel requests, payments that didn't match a user) to your Gmail.
//
// Setup (once):
// 1. Go to https://script.google.com → New project. Delete what's there and paste this whole file. Save.
// 2. Deploy → New deployment → gear icon → Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then approve the permissions (Advanced → Go to project → Allow).
// 3. Copy the Web app URL (ends with /exec) into Vercel → bahad-quiz → Settings → Environment Variables
//    as NOTIFY_URL, then redeploy.
//
// The recipient is fixed here, so whoever has the URL can only send mail to you, never to anyone else.
const TO = 'rombarat3336@gmail.com';

function doPost(e) {
  const d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  const subject = String(d.subject || 'בוחן בה״ד 1').slice(0, 200);
  MailApp.sendEmail({ to: TO, subject: subject, body: String(d.text || ''), htmlBody: String(d.html || d.text || ''), name: 'בוחן בה״ד 1' });
  return ContentService.createTextOutput('ok');
}

// Run this once from the editor (select testMail → Run) to check that mail arrives.
function testMail() {
  MailApp.sendEmail(TO, 'בדיקה: התראות בוחן בה״ד 1', 'אם המייל הזה הגיע, ההתראות מוגדרות נכון.');
}
