// worker/index.js
//
// ProvChart API — Cloudflare Worker
//
// Env vars required (set via `wrangler secret put`):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role — server-side only, never shipped to browser)
//   PAYSTACK_SECRET        (secret key, for webhook signature verification)
//
// Build note: this imports provchart-core.js directly. Wrangler's default
// bundler (esbuild) interops CommonJS/UMD modules into the ESM import below,
// so no changes to provchart-core.js are needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import ProvChart from './provchart-core.js';

const FREE_MAX_SERIES = 1;
const PRO_MAX_SERIES = 12;
const MAX_POINTS_PER_SERIES = 200; // sanity ceiling regardless of plan

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

/** Verify a Paystack webhook signature using HMAC-SHA512 over the raw body. */
async function verifyPaystackSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(computedHex, signatureHeader);
}

/** Constant-time string comparison — avoids leaking match length via timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsPreflight();

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    async function getUser(authHeader) {
      if (!authHeader) return null;
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error) return null;
      return user;
    }

    async function getSubscription(userId) {
      const { data } = await supabase
        .schema('provchart')
        .from('subscriptions')
        .select('status, expires_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (!data) return { active: false };
      const expired = data.expires_at && new Date(data.expires_at) < new Date();
      return { active: data.status === 'active' && !expired };
    }

    async function logUsage(userId, endpoint, chartType, seriesCount, pointsCount) {
      // Fire-and-forget-ish, but still awaited so failures don't silently vanish in logs.
      const { error } = await supabase.schema('provchart').from('usage_logs').insert({
        user_id: userId,
        endpoint,
        chart_type: chartType,
        series_count: seriesCount,
        points_count: pointsCount,
      });
      if (error) console.error('usage_logs insert failed:', error.message);
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/check-subscription
    // ─────────────────────────────────────────────────────────────
    if (path === '/api/check-subscription' && request.method === 'GET') {
      const user = await getUser(request.headers.get('Authorization'));
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
      const { active } = await getSubscription(user.id);
      return jsonResponse({ active });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/generate-pro
    // ─────────────────────────────────────────────────────────────
    if (path === '/api/generate-pro' && request.method === 'POST') {
      const user = await getUser(request.headers.get('Authorization'));
      if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

      const { active } = await getSubscription(user.id);
      if (!active) return jsonResponse({ error: 'An active Pro subscription is required.' }, 403);

      let payload;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body.' }, 400);
      }

      const { type, series = [], axisX, theme } = payload;

      if (!['line', 'bar', 'gauge'].includes(type)) {
        return jsonResponse({ error: `Unsupported chart type: ${type}` }, 400);
      }
      if (!Array.isArray(series) || series.length === 0) {
        return jsonResponse({ error: 'At least one series is required.' }, 400);
      }
      if (series.length > PRO_MAX_SERIES) {
        return jsonResponse({ error: `Pro plan supports up to ${PRO_MAX_SERIES} series.` }, 400);
      }
      for (const s of series) {
        if (!Array.isArray(s.points) || s.points.length === 0) {
          return jsonResponse({ error: 'Every series needs at least one point.' }, 400);
        }
        if (s.points.length > MAX_POINTS_PER_SERIES) {
          return jsonResponse({ error: `Max ${MAX_POINTS_PER_SERIES} points per series.` }, 400);
        }
      }

      let result;
      try {
        if (type === 'line') {
          result = ProvChart.line({ series, axisX, theme });
        } else if (type === 'bar') {
          result = ProvChart.bar({
            bars: series[0].points.map((v, i) => ({
              label: axisX?.[i] || `Item ${i + 1}`,
              value: v,
              color: series[0].color,
            })),
          });
        } else if (type === 'gauge') {
          result = ProvChart.gauge({ value: series[0].points[0], color: series[0].color });
        }
      } catch (err) {
        return jsonResponse({ error: err.message }, 400);
      }

      const pointsCount = series.reduce((acc, s) => acc + s.points.length, 0);
      await logUsage(user.id, '/api/generate-pro', type, series.length, pointsCount);

      return jsonResponse({ html: result.html, css: result.css });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/paystack-webhook
    // ─────────────────────────────────────────────────────────────
    if (path === '/api/paystack-webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const signature = request.headers.get('x-paystack-signature');

      const valid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET);
      if (!valid) {
        console.error('Paystack webhook: signature mismatch — request rejected.');
        return new Response('Invalid signature', { status: 401 });
      }

      const event = JSON.parse(rawBody);
      const eventType = event.event;
      const data = event.data;

      // user_id travels as metadata set at checkout time — see billing.js
      // startPayment(). This avoids an unreliable lookup-by-email.
      const userId = data?.metadata?.user_id;

      if ((eventType === 'charge.success' || eventType === 'subscription.create') && userId) {
        const plan = data?.metadata?.plan || 'pro';
        const { error } = await supabase.schema('provchart').from('subscriptions').upsert(
          {
            user_id: userId,
            status: 'active',
            plan,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            paystack_subscription_code: data.subscription_code || data.reference || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
        if (error) console.error('subscription upsert failed:', error.message);
      }

      if ((eventType === 'subscription.disable' || eventType === 'subscription.not_renew') && userId) {
        const { error } = await supabase
          .schema('provchart')
          .from('subscriptions')
          .update({ status: 'inactive', updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (error) console.error('subscription downgrade failed:', error.message);
      }

      // Always 200 quickly — Paystack retries on non-2xx, and slow handlers
      // risk duplicate deliveries. Everything above is already await'd fast.
      return new Response('OK');
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

