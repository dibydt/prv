// worker/index.js — full version with support for all chart types
import { createClient } from '@supabase/supabase-js';
import ProvChart from './provchart-core.js';

const FREE_MAX_SERIES = 1;
const PRO_MAX_SERIES = 12;
const MAX_POINTS_PER_SERIES = 200;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error('UNHANDLED WORKER ERROR:', err);
      return jsonResponse(
        {
          error: 'Worker crashed',
          message: err?.message || String(err),
          stack: err?.stack || null,
          name: err?.name || null,
        },
        500
      );
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return corsPreflight();

  // Health check
  if (path === '/api/health' && request.method === 'GET') {
    return jsonResponse({
      ok: true,
      time: new Date().toISOString(),
      hasSupabaseUrl: Boolean(env.SUPABASE_URL),
      hasSupabaseKey: Boolean(env.SUPABASE_SERVICE_KEY),
      hasPaystackSecret: Boolean(env.PAYSTACK_SECRET),
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return jsonResponse(
      { error: 'Missing environment variables' },
      500
    );
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  async function getUser(authHeader) {
    if (!authHeader) return null;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) {
      console.error('getUser error:', error.message);
      return null;
    }
    return user;
  }

  async function getSubscription(userId) {
    const { data, error } = await supabase
      .from('provchart_subscriptions')
      .select('status, expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('getSubscription error:', error.message);
      return { active: false };
    }
    if (!data) return { active: false };
    const expired = data.expires_at && new Date(data.expires_at) < new Date();
    return { active: data.status === 'active' && !expired };
  }

  async function logUsage(userId, endpoint, chartType, seriesCount, pointsCount) {
    const { error } = await supabase.from('provchart_usage_logs').insert({
      user_id: userId,
      endpoint,
      chart_type: chartType,
      series_count: seriesCount,
      points_count: pointsCount,
    });
    if (error) console.error('usage_logs insert failed:', error.message);
  }

  // GET /api/check-subscription
  if (path === '/api/check-subscription' && request.method === 'GET') {
    const user = await getUser(request.headers.get('Authorization'));
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
    const { active } = await getSubscription(user.id);
    return jsonResponse({ active });
  }

  // POST /api/generate-pro
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

    const { type, series = [], axisX, theme, stacked = false, bars } = payload;

    // Validate type
    const allowedTypes = ['line', 'area', 'bar', 'hbar', 'scatter', 'combo', 'stackedbar', 'gauge'];
    if (!allowedTypes.includes(type)) {
      return jsonResponse({ error: `Unsupported chart type: ${type}. Allowed: ${allowedTypes.join(', ')}` }, 400);
    }

    // Validate series
    if (type !== 'hbar' && type !== 'gauge') {
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
    } else if (type === 'gauge') {
      if (!series || series.length === 0) return jsonResponse({ error: 'At least one series required for gauge.' }, 400);
    }

    let result;
    try {
      switch (type) {
        case 'line':
        case 'area':
        case 'scatter':
        case 'combo':
          // For combo, the series array may include a 'type' per series.
          // Pass everything through; the core will handle it.
          result = ProvChart[type]({ series, axisX, theme });
          break;

        case 'bar':
          // Support stacked flag (either from payload or per-series)
          // If any series has stack: true, we'll pass stacked: true
          const shouldStack = stacked || series.some(s => s.stack === true);
          result = ProvChart.bar({ series, axisX, theme, stacked: shouldStack });
          break;

        case 'stackedbar':
          // Explicit stacked bar – ensure all series are stacked
          result = ProvChart.bar({ series, axisX, theme, stacked: true });
          break;

        case 'hbar':
          // Horizontal bar: convert series[0] to bars format
          if (!series || series.length === 0) {
            return jsonResponse({ error: 'At least one series required for hbar.' }, 400);
          }
          const barItems = series[0].points.map((v, i) => ({
            label: axisX?.[i] || `Item ${i + 1}`,
            value: v,
            color: series[0].color || '#8b7bff',
          }));
          result = ProvChart.hbar({ bars: barItems, theme });
          break;

        case 'gauge':
          result = ProvChart.gauge({
            value: series[0].points[0] || 0,
            color: series[0].color || '#8b7bff',
            theme,
          });
          break;

        default:
          throw new Error(`Unsupported chart type: ${type}`);
      }
    } catch (err) {
      console.error('ProvChart generation error:', err);
      return jsonResponse({ error: err.message, stack: err.stack }, 400);
    }

    const pointsCount = series.reduce((acc, s) => acc + (s.points?.length || 0), 0);
    await logUsage(user.id, '/api/generate-pro', type, series.length, pointsCount);

    return jsonResponse({ html: result.html, css: result.css });
  }

  // POST /api/paystack-webhook
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
    const userId = data?.metadata?.user_id;

    if ((eventType === 'charge.success' || eventType === 'subscription.create') && userId) {
      const plan = data?.metadata?.plan || 'pro';
      await supabase.from('provchart_subscriptions').upsert(
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
    }

    if ((eventType === 'subscription.disable' || eventType === 'subscription.not_renew') && userId) {
      await supabase
        .from('provchart_subscriptions')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('user_id', userId);
    }

    return new Response('OK');
  }

  return jsonResponse({ error: 'Not found', path }, 404);
}
