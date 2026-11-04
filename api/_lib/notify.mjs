// Emails to the owner, sent through a small Google Apps Script web app on the owner's Gmail
// (code and setup steps: tools/notify-apps-script.gs). NOTIFY_URL is that web app's /exec address.
// The recipient is fixed inside the script, so the URL can only ever mail the owner.
// Never throws: a missing or failing notifier must not break a cancel or a payment.
export async function notify(subject, lines) {
  const url = process.env.NOTIFY_URL;
  if (!url) return false;
  const text = lines.filter(Boolean).join('\n');
  const html = `<div dir="rtl" style="font:15px/1.6 Arial,sans-serif">${lines.filter(Boolean).map(l =>
    String(l).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>')).join('<br>')}</div>`;
  try {
    // Apps Script answers a POST with a redirect to the result page; the mail is already sent by then.
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, text, html }), redirect: 'manual', signal: AbortSignal.timeout(8000)
    });
    return r.status < 400;
  } catch (e) {
    console.error('notify failed', e && e.message);
    return false;
  }
}

// Link to the owner's page, with the key so it opens straight from the email.
export function adminLink(req) {
  const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'bahad-quiz.vercel.app';
  const k = process.env.ADMIN_KEY ? `?key=${encodeURIComponent(process.env.ADMIN_KEY)}` : '';
  return `https://${host}/api/admin${k}`;
}
