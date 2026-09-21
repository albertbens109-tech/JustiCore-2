/**
 * Justicore USSD relay: Cloudflare Worker.
 *
 * Why it exists: Africa's Talking posts each USSD step to a callback URL and expects the next
 * screen (text beginning CON or END) in the direct reply, within a few seconds. A Google Apps
 * Script web app answers every POST with a redirect, so it cannot safely be the callback itself.
 * This worker receives the callback, forwards it to Apps Script, follows the redirect and
 * returns the plain-text screen to Africa's Talking.
 *
 * Settings (Cloudflare dashboard > Workers > this worker > Settings > Variables and Secrets):
 *   APPS_SCRIPT_URL   the Apps Script web app URL ending in /exec          (type: Text)
 *   RELAY_SECRET      the RELAY_SECRET printed by setup() in Apps Script   (type: Secret)
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Justicore USSD relay is running.', { status: 200 });
    }

    let incoming;
    try {
      incoming = await request.formData();
    } catch (err) {
      return plain('END Invalid request.');
    }

    const body = new URLSearchParams();
    for (const [k, v] of incoming) body.append(k, String(v));
    body.set('action', 'ussd');
    body.set('secret', env.RELAY_SECRET || '');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = (await res.text()).trim();
      if (!/^(CON|END) /.test(text)) throw new Error('Unexpected reply: ' + text.slice(0, 120));
      return plain(text);
    } catch (err) {
      console.log('Relay error', err && err.message);
      return plain('END Justicore is busy right now. Please dial again in a few minutes.');
    }
  },
};

function plain(text) {
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
