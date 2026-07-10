import {
  buildListMeta,
  createExternalError,
  createExternalSuccess,
  getExternalStorageAdapter,
  normalizeStringArray,
  paginate,
  parseBooleanParam,
  parsePagination,
  readExternalJson,
  sortBySortIndex
} from './external-api-utils.js';
import { isRemoteSubscription, toExternalSubscription } from './external-api-mappers.js';

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix = 'sub') {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  } catch {}
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextSortIndex(items) {
  return items.reduce((max, item) => Math.max(max, Number(item?.sortIndex) || 0), 0) + 1;
}

async function loadRemoteSubscriptions(storageAdapter) {
  const all = await storageAdapter.getAllSubscriptions();
  return sortBySortIndex(all.filter(isRemoteSubscription));
}

async function getSubscriptionById(storageAdapter, id) {
  const item = await storageAdapter.getSubscriptionById(id);
  if (!item || !isRemoteSubscription(item)) return null;
  return item;
}

async function removeSubscriptionIdFromProfiles(storageAdapter, id) {
  const profiles = await storageAdapter.getAllProfiles();
  const affected = [];
  for (const profile of profiles) {
    const subscriptions = Array.isArray(profile.subscriptions) ? profile.subscriptions : [];
    if (!subscriptions.includes(id)) continue;
    const updated = { ...profile, subscriptions: subscriptions.filter(item => item !== id), updatedAt: nowIso() };
    await storageAdapter.putProfile(updated);
    affected.push(profile.id);
  }
  return affected;
}

export async function handleExternalSubscriptionsRequest(request, env, id = null) {
  const storageAdapter = await getExternalStorageAdapter(env);
  const url = new URL(request.url);

  if (request.method === 'GET' && !id) {
    const all = await loadRemoteSubscriptions(storageAdapter);
    const enabledFilter = parseBooleanParam(url.searchParams.get('enabled'));
    const groupFilter = (url.searchParams.get('group') || '').trim();
    const keyword = (url.searchParams.get('keyword') || '').trim().toLowerCase();
    const filtered = all.filter(item => {
      if (enabledFilter !== undefined && (item.enabled !== false) !== enabledFilter) return false;
      if (groupFilter && String(item.group || '') !== groupFilter) return false;
      if (keyword) {
        const haystack = `${item.name || ''}\n${item.url || ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
    const { page, pageSize } = parsePagination(url);
    return createExternalSuccess(
      paginate(filtered.map(toExternalSubscription), page, pageSize),
      200,
      buildListMeta({ page, pageSize, total: filtered.length })
    );
  }

  if (request.method === 'GET' && id) {
    const item = await getSubscriptionById(storageAdapter, id);
    if (!item) return createExternalError('subscription_not_found', 'Subscription not found', 404);
    return createExternalSuccess(toExternalSubscription(item));
  }

  if (request.method === 'POST' && !id) {
    const payload = await readExternalJson(request);
    if (!String(payload?.name || '').trim()) return createExternalError('subscription_name_required', 'Subscription name is required', 400);
    if (!String(payload?.url || '').trim()) return createExternalError('subscription_url_required', 'Subscription URL is required', 400);
    if (!isRemoteSubscription(payload)) return createExternalError('invalid_subscription_url', 'Subscription URL must use http or https', 400);

    const all = await storageAdapter.getAllSubscriptions();
    const timestamp = nowIso();
    const item = {
      id: generateId('sub'),
      name: String(payload.name).trim(),
      url: String(payload.url).trim(),
      enabled: payload.enabled !== false,
      group: String(payload.group || '').trim(),
      tags: normalizeStringArray(payload.tags),
      userAgent: String(payload.userAgent || '').trim(),
      proxy: String(payload.proxy || '').trim(),
      sortIndex: Number.isFinite(Number(payload.sortIndex)) ? Number(payload.sortIndex) : nextSortIndex(all),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await storageAdapter.putSubscription(item);
    return createExternalSuccess(toExternalSubscription(item), 201);
  }

  if (request.method === 'PATCH' && id) {
    const current = await getSubscriptionById(storageAdapter, id);
    if (!current) return createExternalError('subscription_not_found', 'Subscription not found', 404);
    const payload = await readExternalJson(request);
    const updated = {
      ...current,
      ...(payload.name !== undefined ? { name: String(payload.name || '').trim() } : {}),
      ...(payload.url !== undefined ? { url: String(payload.url || '').trim() } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled !== false } : {}),
      ...(payload.group !== undefined ? { group: String(payload.group || '').trim() } : {}),
      ...(payload.tags !== undefined ? { tags: normalizeStringArray(payload.tags) } : {}),
      ...(payload.userAgent !== undefined ? { userAgent: String(payload.userAgent || '').trim() } : {}),
      ...(payload.proxy !== undefined ? { proxy: String(payload.proxy || '').trim() } : {}),
      ...(payload.sortIndex !== undefined ? { sortIndex: Number(payload.sortIndex) || 0 } : {}),
      updatedAt: nowIso()
    };
    if (!String(updated.name || '').trim()) return createExternalError('subscription_name_required', 'Subscription name is required', 400);
    if (!String(updated.url || '').trim()) return createExternalError('subscription_url_required', 'Subscription URL is required', 400);
    if (!isRemoteSubscription(updated)) return createExternalError('invalid_subscription_url', 'Subscription URL must use http or https', 400);
    await storageAdapter.putSubscription(updated);
    return createExternalSuccess(toExternalSubscription(updated));
  }

  if (request.method === 'DELETE' && id) {
    const current = await getSubscriptionById(storageAdapter, id);
    if (!current) return createExternalError('subscription_not_found', 'Subscription not found', 404);
    await storageAdapter.deleteSubscriptionById(id);
    const removedFromProfiles = await removeSubscriptionIdFromProfiles(storageAdapter, id);
    return createExternalSuccess({ deleted: true, id, removedFromProfiles });
  }

  return createExternalError('method_not_allowed', 'Method Not Allowed', 405);
}
