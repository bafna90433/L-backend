const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('./models');
const { resolveUserAccess } = require('./access-control');
const { spCall, resetToken, AmazonError } = require('./amazon/client');
const { getAmazonConfig, getPublicAmazonConfig, saveAmazonConfig } = require('./amazon/config');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

/* ------------------------------------------------------------------
   Amazon Seller panel API.

   Everything the panel shows comes through here, so the LWA secret and the
   refresh token stay on the server. The MD always has access; anyone else
   needs the `amazon.view` permission, and `amazon.manage` to touch the
   credentials.

     GET  /api/amazon/settings   -> masked connection details
     PUT  /api/amazon/settings   -> save credentials
     POST /api/amazon/test       -> check the connection works
     GET  /api/amazon/summary    -> the dashboard in one call
     GET  /api/amazon/orders     -> recent orders
     GET  /api/amazon/orders/:id/items
     GET  /api/amazon/inventory  -> what is in stock
   ------------------------------------------------------------------ */

const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

/**
 * Who may open the desk.
 *
 * The MD always can. Anyone else needs the permission the MD hands out from
 * Access Control, which is how a separate Amazon-only login gets made without
 * giving that person the rest of the office.
 */
const allow = permission => async (req, res, next) => {
  try {
    if (req.user.role === 'owner') return next();

    const access = await resolveUserAccess(req.user);
    if (access.isActive === false) {
      return res.status(403).json({ message: 'This account is switched off.' });
    }

    const held = access.permissions || [];
    if (held.includes('*') || held.includes(permission)) return next();

    return res.status(403).json({
      message: 'You do not have access to the Amazon Desk. Ask the MD for permission.'
    });
  } catch {
    return res.status(500).json({ message: 'Could not check your access.' });
  }
};

const canView = allow('amazon.view');
// Changing the credentials is a bigger deal than looking at the numbers.
const canManage = allow('amazon.manage');

const guard = handler => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const status = error instanceof AmazonError ? error.statusCode || 500 : 500;
    res.status(status).json({ message: error.message || 'Amazon request failed.' });
  }
};

/* ---------- settings ---------- */

router.get('/settings', authMiddleware, canView, guard(async (req, res) => {
  res.json(await getPublicAmazonConfig());
}));

router.put('/settings', authMiddleware, canManage, guard(async (req, res) => {
  const saved = await saveAmazonConfig(req.body || {});
  // The old access token belonged to the old credentials.
  resetToken();
  res.json(saved);
}));

router.post('/test', authMiddleware, canManage, guard(async (req, res) => {
  const config = await getAmazonConfig();
  const started = Date.now();

  // Asking for the marketplaces this account can sell in is the lightest call
  // that proves the whole chain works: credentials, token, region, permission.
  const data = await spCall('/sellers/v1/marketplaceParticipations');
  const list = (data?.payload || []).map(entry => ({
    id: entry?.marketplace?.id,
    name: entry?.marketplace?.name,
    country: entry?.marketplace?.countryCode,
    currency: entry?.marketplace?.defaultCurrencyCode,
    selling: entry?.participation?.isParticipating === true
  }));

  res.json({
    ok: true,
    ms: Date.now() - started,
    sandbox: config.sandbox,
    marketplaces: list
  });
}));

/* ---------- orders ---------- */

const ORDER_STATUS = [
  'PendingAvailability',
  'Pending',
  'Unshipped',
  'PartiallyShipped',
  'Shipped',
  'Canceled',
  'Unfulfillable'
];

/** Amazon wants an ISO date; the panel sends a plain number of days. */
const daysAgo = days => {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, Math.min(365, Number(days) || 30)));
  return date.toISOString();
};

const tidyOrder = order => ({
  id: order.AmazonOrderId,
  purchasedAt: order.PurchaseDate,
  updatedAt: order.LastUpdateDate,
  status: order.OrderStatus,
  channel: order.FulfillmentChannel === 'AFN' ? 'FBA' : 'FBM',
  itemCount: Number(order.NumberOfItemsShipped || 0) + Number(order.NumberOfItemsUnshipped || 0),
  shipped: Number(order.NumberOfItemsShipped || 0),
  unshipped: Number(order.NumberOfItemsUnshipped || 0),
  total: order.OrderTotal ? Number(order.OrderTotal.Amount) : 0,
  currency: order.OrderTotal?.CurrencyCode || '',
  buyerName: order.BuyerInfo?.BuyerName || '',
  city: order.ShippingAddress?.City || order.DefaultShipFromLocationAddress?.City || '',
  state: order.ShippingAddress?.StateOrRegion || '',
  shipBy: order.LatestShipDate || '',
  deliverBy: order.LatestDeliveryDate || '',
  isPrime: order.IsPrime === true,
  isBusiness: order.IsBusinessOrder === true
});

router.get('/orders', authMiddleware, canView, guard(async (req, res) => {
  const config = await getAmazonConfig();
  const statuses = String(req.query.status || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => ORDER_STATUS.includes(s));

  const data = await spCall('/orders/v0/orders', {
    query: {
      MarketplaceIds: config.marketplaceId,
      CreatedAfter: daysAgo(req.query.days || 30),
      OrderStatuses: statuses.length ? statuses : undefined,
      MaxResultsPerPage: Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
      NextToken: req.query.nextToken || undefined
    }
  });

  const orders = (data?.payload?.Orders || []).map(tidyOrder);
  res.json({
    orders,
    nextToken: data?.payload?.NextToken || null,
    currency: config.currency,
    sandbox: config.sandbox
  });
}));

router.get('/orders/:id/items', authMiddleware, canView, guard(async (req, res) => {
  const data = await spCall(`/orders/v0/orders/${encodeURIComponent(req.params.id)}/orderItems`);
  const items = (data?.payload?.OrderItems || []).map(item => ({
    asin: item.ASIN,
    sku: item.SellerSKU,
    title: item.Title,
    quantity: Number(item.QuantityOrdered || 0),
    shipped: Number(item.QuantityShipped || 0),
    price: item.ItemPrice ? Number(item.ItemPrice.Amount) : 0,
    currency: item.ItemPrice?.CurrencyCode || '',
    tax: item.ItemTax ? Number(item.ItemTax.Amount) : 0
  }));
  res.json({ items });
}));

/* ---------- inventory ---------- */

router.get('/inventory', authMiddleware, canView, guard(async (req, res) => {
  const config = await getAmazonConfig();

  const data = await spCall('/fba/inventory/v1/summaries', {
    query: {
      granularityType: 'Marketplace',
      granularityId: config.marketplaceId,
      marketplaceIds: config.marketplaceId,
      details: true
    }
  });

  const items = (data?.payload?.inventorySummaries || []).map(row => {
    const detail = row.inventoryDetails || {};
    return {
      asin: row.asin,
      sku: row.sellerSku,
      name: row.productName,
      condition: row.condition,
      total: Number(row.totalQuantity || 0),
      sellable: Number(detail.fulfillableQuantity || 0),
      inbound:
        Number(detail.inboundWorkingQuantity || 0) +
        Number(detail.inboundShippedQuantity || 0) +
        Number(detail.inboundReceivingQuantity || 0),
      unsellable: Number(detail.unfulfillableQuantity?.totalUnfulfillableQuantity || 0),
      reserved: Number(detail.reservedQuantity?.totalReservedQuantity || 0)
    };
  });

  res.json({ items, sandbox: config.sandbox });
}));

/* ---------- the dashboard ---------- */

/**
 * Everything the front page needs, in one request.
 *
 * Amazon rate-limits each API separately and the panel would otherwise fire
 * four calls on every load. One call here also means one place to handle a
 * partial failure — a broken inventory call should not blank the sales.
 */
router.get('/summary', authMiddleware, canView, guard(async (req, res) => {
  const config = await getAmazonConfig();

  // Without credentials every call below would fail the same way; say so once.
  if (!config.connected) {
    return res.status(503).json({
      message: 'Amazon is not connected yet. Add the credentials in Settings.'
    });
  }

  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));

  const settle = async work => {
    try {
      return { ok: true, value: await work };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const [ordersResult, inventoryResult] = await Promise.all([
    settle(
      spCall('/orders/v0/orders', {
        query: {
          MarketplaceIds: config.marketplaceId,
          CreatedAfter: daysAgo(days),
          MaxResultsPerPage: 100
        }
      })
    ),
    settle(
      spCall('/fba/inventory/v1/summaries', {
        query: {
          granularityType: 'Marketplace',
          granularityId: config.marketplaceId,
          marketplaceIds: config.marketplaceId,
          details: true
        }
      })
    )
  ]);

  const orders = ordersResult.ok
    ? (ordersResult.value?.payload?.Orders || []).map(tidyOrder)
    : [];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const live = orders.filter(o => o.status !== 'Canceled');
  const today = live.filter(o => new Date(o.purchasedAt) >= startOfToday);
  const sum = list => list.reduce((total, o) => total + o.total, 0);

  const toShip = live.filter(o => o.status === 'Unshipped' || o.status === 'PartiallyShipped');

  // Which products actually moved, so the panel can rank them.
  const byDay = new Map();
  for (const order of live) {
    const key = String(order.purchasedAt || '').slice(0, 10);
    if (!key) continue;
    const row = byDay.get(key) || { date: key, orders: 0, revenue: 0 };
    row.orders += 1;
    row.revenue += order.total;
    byDay.set(key, row);
  }

  const inventory = inventoryResult.ok
    ? (inventoryResult.value?.payload?.inventorySummaries || []).map(row => ({
        sku: row.sellerSku,
        asin: row.asin,
        name: row.productName,
        sellable: Number(row.inventoryDetails?.fulfillableQuantity || 0),
        total: Number(row.totalQuantity || 0)
      }))
    : [];

  res.json({
    sandbox: config.sandbox,
    currency: config.currency,
    days,
    totals: {
      todayRevenue: sum(today),
      todayOrders: today.length,
      periodRevenue: sum(live),
      periodOrders: live.length,
      averageOrder: live.length ? Math.round((sum(live) / live.length) * 100) / 100 : 0,
      cancelled: orders.length - live.length,
      toShip: toShip.length
    },
    trend: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    needsAction: toShip.slice(0, 10),
    recent: live.slice(0, 8),
    lowStock: inventory
      .filter(item => item.sellable <= 10)
      .sort((a, b) => a.sellable - b.sellable)
      .slice(0, 10),
    stockLines: inventory.length,
    problems: [
      ...(ordersResult.ok ? [] : [{ area: 'Orders', message: ordersResult.error }]),
      ...(inventoryResult.ok ? [] : [{ area: 'Inventory', message: inventoryResult.error }])
    ]
  });
}));

module.exports = router;
