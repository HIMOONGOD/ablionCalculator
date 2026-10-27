import Dexie from 'dexie'

export const MAX_ORDER_BOOK_LEVELS = 50

export const db = new Dexie('AlbionMarketLab')

db.version(1).stores({
  observations: '++id, itemId, city, quality, source, observedAt, [itemId+city+quality]',
})

db.version(2).stores({
  observations: '++id, itemId, city, quality, source, observedAt, [itemId+city+quality]',
  orderBookSnapshots: '++id, itemId, city, quality, source, capturedAt, [itemId+city+quality]',
  orderBookOrders: '++id, snapshotId, side, price, [snapshotId+side]',
})

export async function saveObservations(rows) {
  if (!rows?.length) return 0
  const normalized = rows.map((row) => ({
    ...row,
    itemId: String(row.itemId || row.item_id || '').trim(),
    city: String(row.city || '').trim(),
    quality: Number(row.quality || 1),
    source: row.source || 'API',
    observedAt: row.observedAt || row.observed_at || new Date().toISOString(),
    sellMin: numberOrNull(row.sellMin ?? row.sell_price_min),
    sellMax: numberOrNull(row.sellMax ?? row.sell_price_max),
    buyMin: numberOrNull(row.buyMin ?? row.buy_price_min),
    buyMax: numberOrNull(row.buyMax ?? row.buy_price_max),
    sellMinDate: row.sellMinDate || row.sell_price_min_date || null,
    sellMaxDate: row.sellMaxDate || row.sell_price_max_date || null,
    buyMinDate: row.buyMinDate || row.buy_price_min_date || null,
    buyMaxDate: row.buyMaxDate || row.buy_price_max_date || null,
  })).filter((row) => row.itemId && row.city)

  await db.observations.bulkAdd(normalized)
  return normalized.length
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || Number(value) === 0 || !Number.isFinite(Number(value))) return null
  return Number(value)
}

export async function getAllObservations() {
  return db.observations.orderBy('observedAt').reverse().toArray()
}

function normalizeOrderBookSnapshot({
  itemId,
  city,
  quality = 1,
  source = 'Manual',
  capturedAt = new Date().toISOString(),
  note = '',
  sellOrders = [],
  buyOrders = [],
  requireBothSides = true,
}) {
  const snapshot = {
    itemId: String(itemId || '').trim().toUpperCase(),
    city: String(city || '').trim(),
    quality: Number(quality),
    source: String(source || 'Manual').trim(),
    capturedAt,
    note: String(note || '').trim(),
  }
  if (!snapshot.itemId || !snapshot.city) throw new Error('Choose an item and city before saving.')
  if (!Number.isInteger(snapshot.quality) || snapshot.quality < 1 || snapshot.quality > 5) {
    throw new Error('Quality must be between 1 and 5.')
  }
  if (sellOrders.length > MAX_ORDER_BOOK_LEVELS || buyOrders.length > MAX_ORDER_BOOK_LEVELS) {
    throw new Error(`${snapshot.city} can have at most ${MAX_ORDER_BOOK_LEVELS} orders on each side.`)
  }
  const normalizeOrders = (orders, side) => orders
    .filter((order) => !(order.price === '' && order.amount === ''))
    .map((order, index) => {
      const price = Number(order.price)
      const amount = Number(order.amount)
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) {
        throw new Error(`${side} order ${index + 1} needs a positive price and amount.`)
      }
      return { side, price, amount, position: index + 1 }
    })
  const normalizedOrders = [
    ...normalizeOrders(sellOrders, 'Sell'),
    ...normalizeOrders(buyOrders, 'Buy'),
  ]
  if (requireBothSides && !normalizedOrders.some((order) => order.side === 'Sell')) {
    throw new Error(`${snapshot.city}: enter at least one sell order.`)
  }
  if (requireBothSides && !normalizedOrders.some((order) => order.side === 'Buy')) {
    throw new Error(`${snapshot.city}: enter at least one buy order.`)
  }
  return { snapshot, normalizedOrders }
}

export async function saveOrderBookSnapshots(snapshots) {
  if (!snapshots.length) throw new Error('Select at least one city to save.')
  const normalized = snapshots.map(normalizeOrderBookSnapshot)
  return db.transaction('rw', db.orderBookSnapshots, db.orderBookOrders, async () => {
    const snapshotIds = []
    for (const { snapshot, normalizedOrders } of normalized) {
      const snapshotId = await db.orderBookSnapshots.add(snapshot)
      await db.orderBookOrders.bulkAdd(normalizedOrders.map((order) => ({ ...order, snapshotId })))
      snapshotIds.push(snapshotId)
    }
    return snapshotIds
  })
}

export async function saveOrderBookSnapshot(snapshot) {
  const [snapshotId] = await saveOrderBookSnapshots([snapshot])
  return snapshotId
}

export async function getAllOrderBookSnapshots() {
  const [snapshots, orders] = await Promise.all([
    db.orderBookSnapshots.orderBy('capturedAt').reverse().toArray(),
    db.orderBookOrders.toArray(),
  ])
  const ordersBySnapshot = new Map()
  for (const order of orders) {
    const snapshotOrders = ordersBySnapshot.get(order.snapshotId) || []
    snapshotOrders.push(order)
    ordersBySnapshot.set(order.snapshotId, snapshotOrders)
  }
  return snapshots.map((snapshot) => {
    const snapshotOrders = ordersBySnapshot.get(snapshot.id) || []
    return {
      ...snapshot,
      sellOrders: snapshotOrders.filter((order) => order.side === 'Sell').sort((a, b) => a.position - b.position),
      buyOrders: snapshotOrders.filter((order) => order.side === 'Buy').sort((a, b) => a.position - b.position),
    }
  })
}

export async function clearAllObservations() {
  await db.transaction('rw', db.observations, db.orderBookSnapshots, db.orderBookOrders, async () => {
    await db.orderBookOrders.clear()
    await db.orderBookSnapshots.clear()
    await db.observations.clear()
  })
}