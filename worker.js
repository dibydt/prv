// worker.js — ProvChart API (Dashboard + Developer API)
import { createClient } from '@supabase/supabase-js';
import ProvChart from './provchart-core.js';

// ────────────────────────────────────────────────
// Limits
// ────────────────────────────────────────────────
const PLAN_LIMITS = {
  free:     { monthly: 0,    maxSeries: 1  },
  pro:      { monthly: 500,  maxSeries: 12 },
  business: { monthly: 5000, maxSeries: 50 },
};

const MAX_POINTS_PER_SERIES = 200;

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────
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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    },
  });
}

async function verifyPaystackSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
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

function getCurrentMonth() {
  const d = new Date();
  return `\( {d.getUTCFullYear()}- \){String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'pc_live_';
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// Soft error helper
function softError(message, status = 400, extra = {}) {
  return jsonResponse({
    success: false,
    error: message,
    ...extra,
  }, status);
}

// ────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error('UNHANDLED WORKER ERROR:', err);

      // Soft message for unexpected crashes
      return softError(
        'Something went wrong on our side. Please try again in a moment.',
        500,
        { code: 'INTERNAL_ERROR' }
      );
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return corsPreflight();

  // ── Health ────────────────────────────────────
  if (path === '/api/health' && request.method === 'GET') {
    return jsonResponse({
      ok: true,
      time: new Date().toISOString(),
      hasSupabase: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return softError('Service temporarily unavailable. Please try again later.', 503);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  // ── Helpers ───────────────────────────────────
  async function getUserFromJwt(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  }

  async function getUserFromApiKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('pc_live_')) return null;

    const prefix = apiKey.slice(0, 16); // first 16 chars for lookup
    const hash = await sha256(apiKey);

    const { data, error } = await supabase
      .from('provchart_api_keys')
      .select('id, user_id, revoked')
      .eq('key_prefix', prefix)
      .eq('key_hash', hash)
      .eq('revoked', false)
      .maybeSingle();

    if (error || !data) return null;

    // Update last_used_at (fire and forget)
    supabase
      .from('provchart_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {});

    return { id: data.user_id };
  }

  async function getSubscription(userId) {
    const { data } = await supabase
      .from('provchart_subscriptions')
      .select('status, expires_at, plan')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) return { active: false, plan: 'free' };

    const expired = data.expires_at && new Date(data.expires_at) < new Date();
    const active = data.status === 'active' && !expired;
    return {
      active,
      plan: active ? (data.plan || 'pro') : 'free',
    };
  }

  async function getMonthlyUsage(userId) {
    const month = getCurrentMonth();
    const { data } = await supabase
      .from('provchart_api_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('month', month)
      .maybeSingle();

    return data?.count || 0;
  }

  async function incrementUsage(userId) {
    const month = getCurrentMonth();
    // Upsert + increment
    const { data } = await supabase
      .from('provchart_api_usage')
      .select('id, count')
      .eq('user_id', userId)
      .eq('month', month)
      .maybeSingle();

    if (data) {
      await supabase
        .from('provchart_api_usage')
        .update({ count: data.count + 1 })
        .eq('id', data.id);
    } else {
      await supabase.from('provchart_api_usage').insert({
        user_id: userId,
        month,
        count: 1,
      });
    }
  }

  // ────────────────────────────────────────────────
  // GET /api/check-subscription  (Dashboard)
  // ────────────────────────────────────────────────
  if (path === '/api/check-subscription' && request.method === 'GET') {
    const user = await getUserFromJwt(request.headers.get('Authorization'));
    if (!user) return softError('Unauthorized', 401);

    const sub = await getSubscription(user.id);
    return jsonResponse({ active: sub.active, plan: sub.plan });
  }

  // ────────────────────────────────────────────────
  // POST /api/generate-pro  (Dashboard – JWT auth)
  // ────────────────────────────────────────────────
  if (path === '/api/generate-pro' && request.method === 'POST') {
    const user = await getUserFromJwt(request.headers.get('Authorization'));
    if (!user) return softError('Please sign in to generate charts.', 401);

    const sub = await getSubscription(user.id);
    if (!sub.active) {
      return softError('An active Pro or Business subscription is required.', 403, {
        code: 'SUBSCRIPTION_REQUIRED',
      });
    }

    return await generateChart(request, user.id, sub.plan, '/api/generate-pro');
  }

  // ────────────────────────────────────────────────
  // POST /api/v1/generate  (Developer API – API Key)
  // ────────────────────────────────────────────────
  if (path === '/api/v1/generate' && request.method === 'POST') {
    const apiKey = request.headers.get('X-API-Key') || 
                   request.headers.get('Authorization')?.replace('Bearer ', '');

    const user = await getUserFromApiKey(apiKey);
    if (!user) {
      return softError('Invalid or missing API key.', 401, { code: 'INVALID_API_KEY' });
    }

    const sub = await getSubscription(user.id);
    if (!sub.active || sub.plan === 'free') {
      return softError('This API is only available to Pro and Business users.', 403, {
        code: 'PLAN_REQUIRED',
      });
    }

    // Check monthly limit
    const used = await getMonthlyUsage(user.id);
    const limit = PLAN_LIMITS[sub.plan]?.monthly || 0;

    if (used >= limit) {
      return softError(
        `Monthly limit reached (${limit} generations). Upgrade your plan or wait until next month.`,
        429,
        {
          code: 'MONTHLY_LIMIT_REACHED',
          used,
          limit,
          plan: sub.plan,
        }
      );
    }

    const result = await generateChart(request, user.id, sub.plan, '/api/v1/generate');
    
    // Only increment on success
    if (result.status === 200) {
      await incrementUsage(user.id);
    }

    return result;
  }

// GET /api/v1/usage
if (path === '/api/v1/usage' && request.method === 'GET') {
  let user = null;

  // Try API Key first
  const apiKey = request.headers.get('X-API-Key') || 
                 request.headers.get('Authorization')?.replace('Bearer ', '');
  if (apiKey?.startsWith('pc_live_')) {
    user = await getUserFromApiKey(apiKey);
  } else {
    // Fallback to JWT (for dashboard)
    user = await getUserFromJwt(request.headers.get('Authorization'));
  }

  if (!user) return softError('Unauthorized', 401);

  const sub = await getSubscription(user.id);
  const used = await getMonthlyUsage(user.id);
  const limit = PLAN_LIMITS[sub.plan]?.monthly || 0;

  return jsonResponse({
    plan: sub.plan,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    month: getCurrentMonth(),
  });
}

  // ────────────────────────────────────────────────
  // API Keys management (requires JWT – from dashboard)
  // ────────────────────────────────────────────────
  if (path === '/api/v1/keys' && request.method === 'POST') {
    const user = await getUserFromJwt(request.headers.get('Authorization'));
    if (!user) return softError('Unauthorized', 401);

    const sub = await getSubscription(user.id);
    if (!sub.active) return softError('Pro or Business plan required to create API keys.', 403);

    const body = await request.json().catch(() => ({}));
    const name = body.name || 'Default';

    const fullKey = generateApiKey();
    const prefix = fullKey.slice(0, 16);
    const hash = await sha256(fullKey);

    const { error } = await supabase.from('provchart_api_keys').insert({
      user_id: user.id,
      key_prefix: prefix,
      key_hash: hash,
      name,
    });

    if (error) {
      console.error('API key create error:', error);
      return softError('Could not create API key. Please try again.', 500);
    }

    // Return the full key ONLY once
    return jsonResponse({
      key: fullKey,
      name,
      message: 'Store this key securely. It will not be shown again.',
    });
  }

  if (path === '/api/v1/keys' && request.method === 'GET') {
    const user = await getUserFromJwt(request.headers.get('Authorization'));
    if (!user) return softError('Unauthorized', 401);

    const { data, error } = await supabase
      .from('provchart_api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) return softError('Could not load API keys.', 500);

    return jsonResponse({ keys: data || [] });
  }

  if (path.startsWith('/api/v1/keys/') && request.method === 'DELETE') {
    const user = await getUserFromJwt(request.headers.get('Authorization'));
    if (!user) return softError('Unauthorized', 401);

    const keyId = path.split('/').pop();
    const { error } = await supabase
      .from('provchart_api_keys')
      .update({ revoked: true })
      .eq('id', keyId)
      .eq('user_id', user.id);

    if (error) return softError('Could not revoke key.', 500);
    return jsonResponse({ success: true, message: 'API key revoked.' });
  }

  // ────────────────────────────────────────────────
  // Paystack Webhook
  // ────────────────────────────────────────────────
  if (path === '/api/paystack-webhook' && request.method === 'POST') {
    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature');

    const valid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET);
    if (!valid) {
      console.error('Paystack webhook: signature mismatch');
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

  return softError('Endpoint not found.', 404);

  // ────────────────────────────────────────────────
  // Shared chart generation
  // ────────────────────────────────────────────────
  async function generateChart(request, userId, plan, endpoint) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return softError('Invalid JSON body.');
    }

    const { type, series = [], axisX, theme, stacked = false } = payload;
    const allowedTypes = ['line', 'area', 'bar', 'hbar', 'scatter', 'combo', 'stackedbar', 'gauge'];

    if (!allowedTypes.includes(type)) {
      return softError(`Unsupported chart type: ${type}. Allowed: ${allowedTypes.join(', ')}`);
    }

    const maxSeries = PLAN_LIMITS[plan]?.maxSeries || 1;

    if (type !== 'gauge' && type !== 'hbar') {
      if (!Array.isArray(series) || series.length === 0) {
        return softError('At least one series is required.');
      }
      if (series.length > maxSeries) {
        return softError(`Your plan supports up to ${maxSeries} series.`);
      }
      for (const s of series) {
        if (!Array.isArray(s.points) || s.points.length === 0) {
          return softError('Every series needs at least one point.');
        }
        if (s.points.length > MAX_POINTS_PER_SERIES) {
          return softError(`Max ${MAX_POINTS_PER_SERIES} points per series.`);
        }
      }
    }

    let result;
    try {
      switch (type) {
        case 'line':
        case 'area':
        case 'scatter':
        case 'combo':
          result = ProvChart[type]({ series, axisX, theme });
          break;
        case 'bar':
          result = ProvChart.bar({
            series,
            axisX,
            theme,
            stacked: stacked || series.some(s => s.stack),
          });
          break;
        case 'stackedbar':
          result = ProvChart.bar({ series, axisX, theme, stacked: true });
          break;
        case 'hbar':
          const bars = (series[0]?.points || []).map((v, i) => ({
            label: axisX?.[i] || `Item ${i + 1}`,
            value: v,
            color: series[0]?.color || '#8b7bff',
          }));
          result = ProvChart.hbar({ bars, theme });
          break;
        case 'gauge':
          result = ProvChart.gauge({
            value: series[0]?.points?.[0] || 0,
            color: series[0]?.color || '#8b7bff',
            theme,
          });
          break;
        default:
          return softError(`Unsupported chart type: ${type}`);
      }
    } catch (err) {
      console.error('Chart generation error:', err);
      return softError(err.message || 'Failed to generate chart.');
    }

    // Log usage (optional, for analytics)
    const pointsCount = series.reduce((acc, s) => acc + (s.points?.length || 0), 0);
    await supabase.from('provchart_usage_logs').insert({
      user_id: userId,
      endpoint,
      chart_type: type,
      series_count: series.length,
      points_count: pointsCount,
    }).then(() => {}).catch(() => {});

    return jsonResponse({
      success: true,
      html: result.html,
      css: result.css,
    });
  }
}
