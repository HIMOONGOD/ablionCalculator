export function money(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function dateTime(value) {
  if (!value || String(value).startsWith('0001-01-01')) return 'No timestamp'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

export function ageLabel(value) {
  if (!value || String(value).startsWith('0001-01-01')) return 'Unknown age'
  const ms = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown age'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function latestByItemCityQuality(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = `${row.itemId}|${row.city}|${row.quality}`
    const existing = map.get(key)
    if (!existing || new Date(row.observedAt).getTime() > new Date(existing.observedAt).getTime()) {
      map.set(key, row)
    }
  }
  return [...map.values()]
}

export function analyzeArbitrageRoutes(snapshots, {
  quantity = 1,
  buyMethod = 'instant',
  sellMethod = 'instant',
  sellOrderFeePercent = 8,
  orderSetupFeePercent = 1.8,
  sellOrderPrice = null,
} = {}) {
  const rate = (value) => Math.max(0, Math.min(100, Number(value) || 0)) / 100
  const tradeLimit = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : 0
  const sellFeeRate = sellMethod === 'order' ? rate(sellOrderFeePercent) : 0
  const buySetupRate = buyMethod === 'order' ? rate(orderSetupFeePercent) : 0
  const sellSetupRate = sellMethod === 'order' ? rate(orderSetupFeePercent) : 0
  if (!tradeLimit) return []
  const routes = []
  for (const source of snapshots) {
    const purchaseOrders = (buyMethod === 'instant'
      ? source.sellOrders
      : source.buyOrders.slice(0, 1).map((order) => ({ ...order, amount: tradeLimit })))
      .map((order) => ({ ...order }))
      .sort((a, b) => buyMethod === 'instant' ? a.price - b.price : b.price - a.price)
    for (const destination of snapshots) {
      if (source.city === destination.city || source.quality !== destination.quality) continue
      const saleOrders = sellMethod === 'instant'
        ? destination.buyOrders.map((order) => ({ ...order })).sort((a, b) => b.price - a.price)
        : destination.sellOrders.slice(0, 1).map((order) => ({ ...order, amount: tradeLimit }))
      const plannedSellPrice = Number(sellOrderPrice)
      const sellOrderPriceOverride = sellMethod === 'order' && Number.isFinite(plannedSellPrice) && plannedSellPrice > 0
        ? plannedSellPrice
        : null
      if (sellMethod === 'order' && !saleOrders.length && sellOrderPriceOverride !== null) {
        saleOrders.push({ price: sellOrderPriceOverride, amount: tradeLimit })
      }
      if (!purchaseOrders.length || !saleOrders.length) continue
      const targetSellPrice = sellOrderPriceOverride ?? saleOrders[0].price
      let purchaseIndex = 0
      let saleIndex = 0
      let remaining = tradeLimit
      let quantity = 0
      let invested = 0
      let revenue = 0
      let sellFees = 0
      let buySetupFees = 0
      let sellSetupFees = 0
      while (remaining > 0 && purchaseIndex < purchaseOrders.length &&
        (sellMethod === 'order' || saleIndex < saleOrders.length)) {
        const purchase = purchaseOrders[purchaseIndex]
        const sale = sellMethod === 'order' ? null : saleOrders[saleIndex]
        const buyPrice = purchase.price
        const sellPrice = sellMethod === 'order' ? targetSellPrice : sale.price
        const matched = Math.min(remaining, purchase.amount, sale ? sale.amount : remaining)
        quantity += matched
        remaining -= matched
        invested += buyPrice * matched
        revenue += sellPrice * matched
        sellFees += sellPrice * matched * sellFeeRate
        buySetupFees += buyPrice * matched * buySetupRate
        sellSetupFees += sellPrice * matched * sellSetupRate
        purchase.amount -= matched
        if (sale) sale.amount -= matched
        if (!purchase.amount) purchaseIndex += 1
        if (sale && !sale.amount) saleIndex += 1
      }
      if (quantity) routes.push({
        buyCity: source.city,
        sellCity: destination.city,
        quality: source.quality,
        buyMethod,
        sellMethod,
        sellOrderPrice: sellMethod === 'order' ? targetSellPrice : null,
        quantity,
        requestedQuantity: tradeLimit,
        quantityFilled: quantity,
        quantityShortfall: tradeLimit - quantity,
        fillType: buyMethod === 'instant' && sellMethod === 'instant' ? 'Depth-limited instant fills' : 'Order placement estimate',
        invested,
        revenue,
        buyFees: 0,
        sellFees,
        buySetupFees,
        sellSetupFees,
        setupFees: buySetupFees + sellSetupFees,
        totalFees: sellFees + buySetupFees + sellSetupFees,
        profit: revenue - invested - sellFees - buySetupFees - sellSetupFees,
        averageBuy: invested / quantity,
        averageSell: revenue / quantity,
      })
    }
  }
  return routes.sort((a, b) => b.profit - a.profit)
}