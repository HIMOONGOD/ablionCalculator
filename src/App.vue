<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchMarketPrices } from './api'
import {
  getAllObservations,
  getAllOrderBookSnapshots,
  saveOrderBookSnapshots,
  saveObservations,
  clearAllObservations,
  numberOrNull,
  MAX_ORDER_BOOK_LEVELS,
} from './db'
import { ageLabel, analyzeArbitrageRoutes, dateTime, latestByItemCityQuality, money } from './utils'
import * as XLSX from 'xlsx'
import { createWorker } from 'tesseract.js'
import { loadItemCatalog } from './itemCatalog'

const tab = ref('orderbook-capture')
const loading = ref(false)
const error = ref('')
const notice = ref('')
const allRows = ref([])
const allOrderBooks = ref([])
const search = ref('')
const selectedItem = ref('T3_FIBER')
const cityFilter = ref('All')
const qualityFilter = ref('1')
const itemIdsInput = ref('T3_FIBER')
const selectedCities = ref(['Thetford', 'Martlock', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien', 'Black Market'])
const selectedQualities = ref([1])
const cities = ['Thetford', 'Martlock', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Caerleon', 'Brecilien', 'Black Market']
const qualities = [1, 2, 3, 4, 5]
const lastFetched = ref('')
const manual = ref({ itemId: 'T3_FIBER', city: 'Thetford', quality: 1, sellMin: '', sellMax: '', buyMin: '', buyMax: '', note: '' })
const calc = ref({
  itemId: 'T3_FIBER',
  buyCity: 'Martlock',
  sellCity: 'Thetford',
  quality: 1,
  quantity: 1,
  buyPrice: 0,
  sellPrice: 0,
  buyMethod: 'instant',
  sellMethod: 'instant',
  sellOrderFeePercent: 8,
  orderSetupFeePercent: 1.8,
  sellOrderPrice: '',
})
const importInput = ref(null)
const photoInput = ref(null)
const orderBookPhotoInput = ref(null)
const orderBookOcrCity = ref('')
const orderBookOcrBusyCity = ref('')
const orderBookOcrPreviewUrl = ref('')
const orderBookOcrText = ref('')
const orderBookSources = ref({})
const orderBookForm = ref({
  itemId: 'T3_FIBER',
  quality: 1,
})
const orderBookJson = ref('')
const orderBookJsonCity = ref(cities[0])
const orderBookCapturedAt = ref('')
const selectedOrderBookCities = ref([...cities])
const cityOrderBooks = ref(Object.fromEntries(cities.map((city) => [city, {
  sellOrders: [{ price: '', amount: '' }],
  buyOrders: [{ price: '', amount: '' }],
}])))
const orderBookFilter = ref('T3_FIBER')
const orderBookQualityFilter = ref('1')
const orderBookFees = ref({
  quantity: 2000,
  sellOrderFeePercent: 8,
  orderSetupFeePercent: 1.8,
  sellOrderPrice: '',
})
const routeBuyCityFilter = ref('All')
const routeSellCityFilter = ref('All')
const routeProfitFilter = ref('All')
const catalog = ref([])
const itemSearch = ref('')
const ocrBusy = ref(false)
const ocrProgress = ref(0)
const ocrText = ref('')
const ocrPreviewUrl = ref('')
const itemSearchResults = computed(() => {
  const q = itemSearch.value.trim().toLowerCase()
  if (!q) return catalog.value.slice(0, 15)
  return catalog.value.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(q)).slice(0, 30)
})
const selectedCatalogItem = computed(() => catalog.value.find((item) => item.id === manual.value.itemId))

const latestRows = computed(() => latestByItemCityQuality(allRows.value))
const marketRows = computed(() => latestRows.value.filter((r) => {
  const matchesItem = !selectedItem.value || r.itemId.toLowerCase().includes(selectedItem.value.toLowerCase())
  const matchesCity = cityFilter.value === 'All' || r.city === cityFilter.value
  const matchesQuality = qualityFilter.value === 'All' || Number(r.quality) === Number(qualityFilter.value)
  const matchesSearch = !search.value || `${r.itemId} ${r.city}`.toLowerCase().includes(search.value.toLowerCase())
  return matchesItem && matchesCity && matchesQuality && matchesSearch
}).sort((a, b) => a.itemId.localeCompare(b.itemId) || a.city.localeCompare(b.city)))
const historyRows = computed(() => allRows.value.filter((r) => {
  const term = search.value.toLowerCase()
  return !term || `${r.itemId} ${r.city} ${r.source}`.toLowerCase().includes(term)
}).slice(0, 500))
const apiCount = computed(() => allRows.value.filter((r) => r.source === 'API').length)
const manualCount = computed(() => allRows.value.filter((r) => r.source === 'Manual').length)
const uniqueItems = computed(() => new Set(allRows.value.map((r) => r.itemId)).size)
const validMarketRows = computed(() => marketRows.value.filter((r) => r.sellMin || r.sellMax || r.buyMin || r.buyMax).length)
const latestOrderBooks = computed(() => {
  const latest = new Map()
  for (const snapshot of allOrderBooks.value) {
    const key = `${snapshot.itemId}|${snapshot.city}|${snapshot.quality}`
    if (!latest.has(key)) latest.set(key, snapshot)
  }
  return [...latest.values()]
})
const comparedOrderBooks = computed(() => latestOrderBooks.value.filter((snapshot) => {
  const itemMatches = snapshot.itemId.toLowerCase() === orderBookFilter.value.trim().toLowerCase()
  const qualityMatches = orderBookQualityFilter.value === 'All' || Number(snapshot.quality) === Number(orderBookQualityFilter.value)
  return itemMatches && qualityMatches
}))
const comparedOrderBookLevelCount = computed(() => Math.max(5, ...comparedOrderBooks.value.flatMap((snapshot) => [
  snapshot.sellOrders.length,
  snapshot.buyOrders.length,
])))
const orderBookHistory = computed(() => {
  const previousByMarket = new Map()
  return allOrderBooks.value
    .filter((snapshot) => snapshot.itemId.toLowerCase() === orderBookFilter.value.trim().toLowerCase())
    .filter((snapshot) => orderBookQualityFilter.value === 'All' || Number(snapshot.quality) === Number(orderBookQualityFilter.value))
    .map((snapshot) => {
      const key = `${snapshot.itemId}|${snapshot.city}|${snapshot.quality}`
      const previous = previousByMarket.get(key) || null
      const currentSell = bestOrder(snapshot, 'sell')
      const currentBuy = bestOrder(snapshot, 'buy')
      const previousSell = previous ? bestOrder(previous, 'sell') : null
      const previousBuy = previous ? bestOrder(previous, 'buy') : null
      previousByMarket.set(key, snapshot)
      return {
        ...snapshot,
        bestSell: currentSell,
        bestBuy: currentBuy,
        sellChange: currentSell && previousSell ? currentSell.price - previousSell.price : null,
        buyChange: currentBuy && previousBuy ? currentBuy.price - previousBuy.price : null,
      }
    })
    .slice(0, 200)
})
const arbitrageRoutes = computed(() => {
  const routes = []
  for (const buyMethod of ['instant', 'order']) {
    for (const sellMethod of ['instant', 'order']) {
      const strategy = `${buyMethod === 'instant' ? 'Instant buy' : 'Buy order'} → ${sellMethod === 'instant' ? 'Instant sell' : 'Sell order'}`
      routes.push(...analyzeArbitrageRoutes(comparedOrderBooks.value, {
        ...orderBookFees.value,
        buyMethod,
        sellMethod,
      }).map((route) => ({ ...route, strategy })))
    }
  }
  return routes.sort((a, b) => b.profit - a.profit)
})
const routeCities = computed(() => [...new Set(comparedOrderBooks.value.map((snapshot) => snapshot.city))].sort())
const filteredArbitrageRoutes = computed(() => arbitrageRoutes.value.filter((route) => {
  const buyCityMatches = routeBuyCityFilter.value === 'All' || route.buyCity === routeBuyCityFilter.value
  const sellCityMatches = routeSellCityFilter.value === 'All' || route.sellCity === routeSellCityFilter.value
  const profitMatches = routeProfitFilter.value === 'All'
    || (routeProfitFilter.value === 'Profit' && route.profit > 0)
    || (routeProfitFilter.value === 'Loss' && route.profit < 0)
    || (routeProfitFilter.value === 'Break-even' && route.profit === 0)
  return buyCityMatches && sellCityMatches && profitMatches
}))
const calcResult = computed(() => {
  const quantity = Math.max(0, Number(calc.value.quantity) || 0)
  const buy = Math.max(0, Number(calc.value.buyPrice) || 0)
  const sell = calc.value.sellMethod === 'order' && Number(calc.value.sellOrderPrice) > 0
    ? Number(calc.value.sellOrderPrice)
    : Math.max(0, Number(calc.value.sellPrice) || 0)
  const cost = buy * quantity
  const revenue = sell * quantity
  const rate = (value) => Math.max(0, Math.min(100, Number(value) || 0)) / 100
  const sellFees = calc.value.sellMethod === 'order' ? revenue * rate(calc.value.sellOrderFeePercent) : 0
  const setupFees = (calc.value.buyMethod === 'order' ? cost : 0) * rate(calc.value.orderSetupFeePercent) +
    (calc.value.sellMethod === 'order' ? revenue : 0) * rate(calc.value.orderSetupFeePercent)
  const buyFees = 0
  const fees = sellFees + setupFees
  const profit = revenue - cost - fees
  return { cost, revenue, buyFees, sellFees, setupFees, fees, profit, margin: revenue ? (profit / revenue) * 100 : 0 }
})

function addItemToFetchList(item) {
  if (!item) return
  const current = itemIdsInput.value.split(/[\s,;]+/).filter(Boolean)
  if (!current.includes(item.id)) current.push(item.id)
  itemIdsInput.value = current.join(', ')
  selectedItem.value = item.id
  itemSearch.value = item.name
}
function removeFetchItem(id) {
  itemIdsInput.value = itemIdsInput.value.split(/[\s,;]+/).filter((value) => value && value !== id).join(', ')
}
function chooseManualItem(item) {
  if (!item) return
  manual.value.itemId = item.id
  itemSearch.value = item.name
}
function openPhotoPicker() {
  photoInput.value?.click()
}
function openOrderBookPhotoPicker(city) {
  orderBookOcrCity.value = city
  orderBookPhotoInput.value?.click()
}
function normalizeOcrText(text) {
  return String(text || '').replace(/[|]/g, 'I').replace(/[，]/g, ',')
}
function findItemInOcr(text) {
  const normalized = normalizeOcrText(text).toLowerCase()
  return catalog.value.find((item) => normalized.includes(item.id.toLowerCase()) ||
    (item.name.length > 4 && normalized.includes(item.name.toLowerCase())))
}
function parseOcrPrices(text) {
  // OCR cannot know the exact column meaning in every screenshot; this only suggests values for review.
  const matches = [...String(text).matchAll(/(?:^|\\s)(\\d{1,3}(?:,\\d{3})+|\\d{2,7})(?:\\s|$)/gm)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100000000)
  return [...new Set(matches)]
}
function parseOrderBookOcr(words, imageWidth, imageHeight) {
  const orderedWords = words
    .filter((word) => word.text?.trim() && word.bbox)
    .map((word) => ({
      text: word.text.trim().replace(/[oO]/g, '0').replace(/[lI|]/g, '1'),
      x: (word.bbox.x0 + word.bbox.x1) / 2,
      y: (word.bbox.y0 + word.bbox.y1) / 2,
      height: word.bbox.y1 - word.bbox.y0,
    }))
    .sort((a, b) => a.y - b.y)

  const lineThreshold = Math.max(8, imageHeight * 0.018)
  const lines = []
  for (const word of orderedWords) {
    let line = lines.find((candidate) => Math.abs(candidate.y - word.y) <= lineThreshold)
    if (!line) {
      line = { y: word.y, height: word.height, words: [] }
      lines.push(line)
    }
    line.words.push(word)
    line.y = line.words.reduce((sum, part) => sum + part.y, 0) / line.words.length
  }

  const sellHeading = lines.find((line) => /sell\s*orders/i.test(line.words.map((word) => word.text).join(' ')))
  const buyHeading = lines.find((line) => /buy\s*orders/i.test(line.words.map((word) => word.text).join(' ')))
  const priceHeader = lines.find((line) => {
    const text = line.words.map((word) => word.text).join(' ')
    return /price/i.test(text) && /amount/i.test(text)
  })
  const headerY = priceHeader?.y || Math.max(sellHeading?.y || 0, buyHeading?.y || 0, imageHeight * 0.22)
  const rowLines = lines.filter((line) => line.y > headerY + lineThreshold * 1.2)
  const result = { sellOrders: [], buyOrders: [] }

  for (const line of rowLines) {
    const numericWords = line.words
      .filter((word) => /[\d]/.test(word.text))
      .map((word) => ({
        ...word,
        number: Number(word.text.replace(/[^\d]/g, '')),
      }))
      .filter((word) => Number.isSafeInteger(word.number) && word.number > 0)
    const sellWords = numericWords.filter((word) => word.x < imageWidth / 2).sort((a, b) => a.x - b.x)
    const buyWords = numericWords.filter((word) => word.x >= imageWidth / 2).sort((a, b) => a.x - b.x)
    const sellPrice = sellWords.find((word) => word.x < imageWidth * 0.23)
    const sellAmount = [...sellWords].reverse().find((word) => word.x >= imageWidth * 0.23)
    const buyPrice = buyWords.find((word) => word.x < imageWidth * 0.75)
    const buyAmount = [...buyWords].reverse().find((word) => word.x >= imageWidth * 0.75)
    if (sellAmount && sellPrice !== sellAmount) {
      result.sellOrders.push({ price: sellPrice?.number ?? '', amount: sellAmount.number })
    }
    if (buyAmount && buyPrice !== buyAmount) {
      result.buyOrders.push({ price: buyPrice?.number ?? '', amount: buyAmount.number })
    }
  }
  return {
    sellOrders: result.sellOrders.slice(0, 5),
    buyOrders: result.buyOrders.slice(0, 5),
  }
}

async function processOrderBookPhoto(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  const city = orderBookOcrCity.value
  if (!file || !city) return
  if (!file.type.startsWith('image/')) {
    error.value = 'Please select an image file such as PNG, JPG, or WEBP.'
    return
  }

  error.value = ''
  notice.value = ''
  orderBookOcrBusyCity.value = city
  ocrProgress.value = 0
  if (orderBookOcrPreviewUrl.value) URL.revokeObjectURL(orderBookOcrPreviewUrl.value)
  orderBookOcrPreviewUrl.value = URL.createObjectURL(file)
  orderBookOcrText.value = ''
  let image
  let worker
  try {
    image = await createImageBitmap(file)
    worker = await createWorker('eng', 1, {
      logger: (message) => {
        if (message.status === 'recognizing text' && message.progress) {
          ocrProgress.value = Math.round(message.progress * 100)
        }
      },
    })
    const canvas = document.createElement('canvas')
    const scale = Math.max(2, Math.min(3, 1800 / image.width))
    canvas.width = Math.round(image.width * scale)
    canvas.height = Math.round(image.height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare this image for text recognition.')
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })
    const result = await worker.recognize(canvas, {}, { text: true, blocks: true })
    orderBookOcrText.value = normalizeOcrText(result.data.text)
    const words = (result.data.blocks || [])
      .flatMap((block) => block.paragraphs || [])
      .flatMap((paragraph) => paragraph.lines || [])
      .flatMap((line) => line.words || [])
    const rows = parseOrderBookOcr(words, image.width, image.height)
    if (!rows.sellOrders.length || !rows.buyOrders.length) {
      throw new Error(`Could not detect both order tables for ${city}. Enter the rows manually or try a clearer full-table screenshot.`)
    }
    cityOrderBooks.value[city] = {
      sellOrders: rows.sellOrders,
      buyOrders: rows.buyOrders,
    }
    orderBookSources.value[city] = 'Screenshot'
    notice.value = `${city}: read ${rows.sellOrders.length} sell and ${rows.buyOrders.length} buy row(s). Fill any blank prices and verify every recognized value before saving.`
  } catch (e) {
    error.value = e.message || `Could not read the ${city} order-book screenshot.`
  } finally {
    if (worker) await worker.terminate()
    image?.close()
    orderBookOcrBusyCity.value = ''
  }
}
async function processMarketPhoto(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    error.value = 'Please select an image file such as PNG, JPG, or WEBP.'
    return
  }
  if (ocrPreviewUrl.value) URL.revokeObjectURL(ocrPreviewUrl.value)
  ocrPreviewUrl.value = URL.createObjectURL(file)
  ocrBusy.value = true
  ocrProgress.value = 0
  ocrText.value = ''
  error.value = ''
  notice.value = ''
  try {
    const worker = await createWorker('eng', 1, {
      logger: (message) => {
        if (message.status === 'recognizing text' && message.progress) {
          ocrProgress.value = Math.round(message.progress * 100)
        }
      },
    })
    try {
      const result = await worker.recognize(file)
      const text = normalizeOcrText(result.data.text)
      ocrText.value = text
      const item = findItemInOcr(text)
      if (item) {
        manual.value.itemId = item.id
        itemSearch.value = item.name
      }
      const city = cities.find((name) => new RegExp(`\\\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\b`, 'i').test(text))
      if (city) manual.value.city = city
      const nums = parseOcrPrices(text)
      // Only prefill suggestions, never silently assume the OCR's numbers are correct.
      if (nums.length >= 1 && !manual.value.sellMin) manual.value.sellMin = String(nums[0])
      if (nums.length >= 2 && !manual.value.sellMax) manual.value.sellMax = String(nums[1])
      if (nums.length >= 3 && !manual.value.buyMin) manual.value.buyMin = String(nums[2])
      if (nums.length >= 4 && !manual.value.buyMax) manual.value.buyMax = String(nums[3])
      notice.value = `Photo scanned. ${item ? `Matched item: ${item.name}. ` : 'Could not confidently match an item name. '}${city ? `Detected city: ${city}. ` : ''}Please verify every suggested field before saving.`
    } finally {
      await worker.terminate()
    }
  } catch (e) {
    error.value = `Could not read this image: ${e.message || 'OCR failed'}. You can still enter the price manually.`
  } finally {
    ocrBusy.value = false
  }
}
async function refreshRows() {
  const [observations, snapshots] = await Promise.all([getAllObservations(), getAllOrderBookSnapshots()])
  allRows.value = observations
  allOrderBooks.value = snapshots
}

function addOrder(city, side) {
  const orders = cityOrderBooks.value[city][`${side}Orders`]
  if (orders.length < MAX_ORDER_BOOK_LEVELS) orders.push({ price: '', amount: '' })
}

function removeOrder(city, side, index) {
  const orders = cityOrderBooks.value[city][`${side}Orders`]
  if (orders.length > 1) orders.splice(index, 1)
}

function importOrderBookJson() {
  error.value = ''
  notice.value = ''
  try {
    const data = JSON.parse(orderBookJson.value)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Paste one order-book JSON object.')
    }

    const itemId = String(data.item_id ?? data.itemId ?? orderBookForm.value.itemId).trim().toUpperCase()
    const requestedCity = String(data.city ?? orderBookJsonCity.value).trim()
    const city = cities.find((availableCity) => availableCity.toLowerCase() === requestedCity.toLowerCase())
    const qualityValue = data.quality ?? orderBookForm.value.quality
    const quality = Number(qualityValue)
    const capturedAtValue = data.captured_at ?? data.capturedAt ?? ''
    const capturedAt = capturedAtValue ? new Date(capturedAtValue) : null

    if (!itemId) throw new Error('Enter an item ID in the JSON or capture form.')
    if (!city) throw new Error(`Unknown city "${requestedCity}". Choose one of the supported cities.`)
    if (!Number.isInteger(quality) || quality < 1 || quality > 5) {
      throw new Error('Quality must be a whole number between 1 and 5.')
    }
    if (capturedAtValue && (!capturedAt || Number.isNaN(capturedAt.getTime()))) {
      throw new Error('captured_at must be a valid date/time or null.')
    }

    const parseOrders = (orders, side) => {
      if (!Array.isArray(orders) || orders.length === 0) {
        throw new Error(`${side} orders must be a non-empty array.`)
      }
      if (orders.length > MAX_ORDER_BOOK_LEVELS) {
        throw new Error(`${side} orders can have at most ${MAX_ORDER_BOOK_LEVELS} levels.`)
      }
      return orders.map((order, index) => {
        const price = Number(order?.price)
        const amount = Number(order?.amount)
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) {
          throw new Error(`${side} order ${index + 1} needs a positive price and amount.`)
        }
        return { price, amount }
      })
    }

    const sellOrders = parseOrders(data.sell_orders ?? data.sellOrders, 'Sell')
    const buyOrders = parseOrders(data.buy_orders ?? data.buyOrders, 'Buy')
    orderBookForm.value = { itemId, quality }
    orderBookJsonCity.value = city
    orderBookCapturedAt.value = capturedAt ? capturedAt.toISOString() : ''
    selectedOrderBookCities.value = [city]
    cityOrderBooks.value[city] = { sellOrders, buyOrders }
    orderBookSources.value[city] = 'JSON'
    notice.value = `Loaded ${sellOrders.length} sell and ${buyOrders.length} buy levels for ${itemId} in ${city}. Review the data, then save the snapshot.`
  } catch (e) {
    error.value = e instanceof SyntaxError
      ? `Invalid JSON: ${e.message}`
      : e.message || 'Could not import this order-book JSON.'
  }
}

function toggleOrderBookCity(city) {
  if (selectedOrderBookCities.value.includes(city)) {
    selectedOrderBookCities.value = selectedOrderBookCities.value.filter((selected) => selected !== city)
    return
  }
  selectedOrderBookCities.value = [...selectedOrderBookCities.value, city]
  if (!cityOrderBooks.value[city]) {
    cityOrderBooks.value[city] = {
      sellOrders: [{ price: '', amount: '' }],
      buyOrders: [{ price: '', amount: '' }],
    }
  }
}

function bestOrder(snapshot, side) {
  const orders = snapshot[`${side}Orders`] || []
  return orders.reduce((best, order) => {
    if (!best) return order
    return side === 'sell'
      ? order.price < best.price ? order : best
      : order.price > best.price ? order : best
  }, null)
}

function changeLabel(change) {
  if (change === null) return '—'
  return `${change > 0 ? '+' : ''}${money(change)}`
}

async function saveOrderBook(citiesToSave = selectedOrderBookCities.value) {
  error.value = ''
  notice.value = ''
  try {
    if (!orderBookForm.value.itemId.trim()) throw new Error('Enter an item ID.')
    if (!citiesToSave.length) throw new Error('Select at least one city.')
    const capturedAt = orderBookCapturedAt.value || new Date().toISOString()
    const snapshots = citiesToSave.map((city) => ({
      itemId: orderBookForm.value.itemId,
      city,
      quality: orderBookForm.value.quality,
      source: orderBookSources.value[city] || 'Manual',
      capturedAt,
      ...cityOrderBooks.value[city],
    }))
    await saveOrderBookSnapshots(snapshots)
    await refreshRows()
    orderBookCapturedAt.value = ''
    orderBookFilter.value = orderBookForm.value.itemId.trim().toUpperCase()
    orderBookQualityFilter.value = String(orderBookForm.value.quality)
    notice.value = `Saved ${snapshots.length} city order book${snapshots.length === 1 ? '' : 's'} for ${orderBookForm.value.itemId.trim().toUpperCase()}. Earlier snapshots were preserved.`
  } catch (e) {
    error.value = e.message || 'Could not save this order book.'
  }
}
async function loadPrices() {
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const itemIds = itemIdsInput.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
    const raw = await fetchMarketPrices({ itemIds, cities: selectedCities.value, qualities: selectedQualities.value })
    const now = new Date().toISOString()
    const rows = raw.map((r) => ({ ...r, itemId: r.item_id, source: 'API', observedAt: now }))
    const count = await saveObservations(rows)
    await refreshRows()
    lastFetched.value = now
    notice.value = `Fetched ${raw.length} API row(s); saved ${count} observation(s). Old history was preserved.`
  } catch (e) {
    error.value = e?.response?.status
      ? `API request failed (HTTP ${e.response.status}). Check the item ID, network, or try again later.`
      : (e.message || 'Could not fetch prices. Check your internet connection and try again.')
  } finally {
    loading.value = false
  }
}
async function addManualPrice() {
  error.value = ''
  notice.value = ''
  const row = {
    itemId: manual.value.itemId.trim().toUpperCase(),
    city: manual.value.city,
    quality: Number(manual.value.quality),
    source: 'Manual',
    observedAt: new Date().toISOString(),
    sellMin: numberOrNull(manual.value.sellMin),
    sellMax: numberOrNull(manual.value.sellMax),
    buyMin: numberOrNull(manual.value.buyMin),
    buyMax: numberOrNull(manual.value.buyMax),
    note: manual.value.note.trim(),
  }
  if (!row.itemId) { error.value = 'Enter an item ID.'; return }
  if (![row.sellMin, row.sellMax, row.buyMin, row.buyMax].some((v) => v !== null)) {
    error.value = 'Enter at least one non-zero price.'
    return
  }
  await saveObservations([row])
  await refreshRows()
  selectedItem.value = row.itemId
  cityFilter.value = row.city
  qualityFilter.value = String(row.quality)
  notice.value = `Manual observation saved for ${row.itemId} in ${row.city}.`
  manual.value.sellMin = ''
  manual.value.sellMax = ''
  manual.value.buyMin = ''
  manual.value.buyMax = ''
  manual.value.note = ''
}
function setCalculatorFromRow(row) {
  calc.value.itemId = row.itemId
  calc.value.quality = row.quality
  calc.value.buyPrice = row.buyMax || row.buyMin || 0
  calc.value.sellPrice = row.sellMin || row.sellMax || 0
  tab.value = 'calculator'
}
function exportExcel() {
  const data = allRows.value.map((r) => ({
    ItemID: r.itemId, City: r.city, Quality: r.quality, Source: r.source,
    ObservedAt: r.observedAt, SellMin: r.sellMin ?? '', SellMinDate: r.sellMinDate ?? '',
    SellMax: r.sellMax ?? '', SellMaxDate: r.sellMaxDate ?? '',
    BuyMin: r.buyMin ?? '', BuyMinDate: r.buyMinDate ?? '',
    BuyMax: r.buyMax ?? '', BuyMaxDate: r.buyMaxDate ?? '', Note: r.note ?? '',
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Price History')
  const snapshots = allOrderBooks.value.map((snapshot) => ({
    SnapshotID: snapshot.id,
    ItemID: snapshot.itemId,
    City: snapshot.city,
    Quality: snapshot.quality,
    Source: snapshot.source,
    CapturedAt: snapshot.capturedAt,
    Note: snapshot.note || '',
  }))
  const sellOrders = allOrderBooks.value.flatMap((snapshot) => snapshot.sellOrders.map((order) => ({
    SnapshotID: snapshot.id, Position: order.position, Price: order.price, Amount: order.amount,
  })))
  const buyOrders = allOrderBooks.value.flatMap((snapshot) => snapshot.buyOrders.map((order) => ({
    SnapshotID: snapshot.id, Position: order.position, Price: order.price, Amount: order.amount,
  })))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapshots), 'Snapshots')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sellOrders), 'Sell Orders')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buyOrders), 'Buy Orders')
  const guide = [
    ['Albion Market Lab backup'],
    ['Exported at', new Date().toISOString()],
    ['Important', 'API values are community observations and may be stale or missing. Zero values are treated as unavailable.'],
    ['Order books', 'Snapshots are metadata rows; Sell Orders and Buy Orders reference SnapshotID.'],
    ['Storage', 'This workbook is an export/backup; IndexedDB is the live local store.'],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), 'Read Me')
  XLSX.writeFile(wb, `albion-market-history-${new Date().toISOString().slice(0,10)}.xlsx`)
}
function triggerImport() { importInput.value?.click() }
async function importExcel(event) {
  error.value = ''
  notice.value = ''
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false })
    const priceSheetName = workbook.SheetNames.find((n) => n.toLowerCase() === 'price history')
    const data = priceSheetName
      ? XLSX.utils.sheet_to_json(workbook.Sheets[priceSheetName], { defval: '' })
      : workbook.SheetNames.length
        ? XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })
        : []
    const rows = data.map((r) => ({
      itemId: r.ItemID ?? r.itemId ?? r.item_id,
      city: r.City ?? r.city,
      quality: r.Quality ?? r.quality ?? 1,
      source: r.Source ?? r.source ?? 'Imported',
      observedAt: r.ObservedAt ?? r.observedAt ?? new Date().toISOString(),
      sellMin: r.SellMin ?? r.sellMin ?? r.sell_price_min,
      sellMax: r.SellMax ?? r.sellMax ?? r.sell_price_max,
      buyMin: r.BuyMin ?? r.buyMin ?? r.buy_price_min,
      buyMax: r.BuyMax ?? r.buyMax ?? r.buy_price_max,
      sellMinDate: r.SellMinDate ?? r.sellMinDate,
      sellMaxDate: r.SellMaxDate ?? r.sellMaxDate,
      buyMinDate: r.BuyMinDate ?? r.buyMinDate,
      buyMaxDate: r.BuyMaxDate ?? r.buyMaxDate,
      note: r.Note ?? r.note ?? '',
    }))
    const count = rows.length ? await saveObservations(rows) : 0
    let snapshotCount = 0
    const snapshotSheetName = workbook.SheetNames.find((n) => n.toLowerCase() === 'snapshots')
    if (snapshotSheetName) {
      const snapshotRows = XLSX.utils.sheet_to_json(workbook.Sheets[snapshotSheetName], { defval: '' })
      const sellSheetName = workbook.SheetNames.find((n) => n.toLowerCase() === 'sell orders')
      const buySheetName = workbook.SheetNames.find((n) => n.toLowerCase() === 'buy orders')
      const sells = sellSheetName ? XLSX.utils.sheet_to_json(workbook.Sheets[sellSheetName], { defval: '' }) : []
      const buys = buySheetName ? XLSX.utils.sheet_to_json(workbook.Sheets[buySheetName], { defval: '' }) : []
      for (const snapshot of snapshotRows) {
        const snapshotId = snapshot.SnapshotID ?? snapshot.snapshotId
        const getOrders = (rows) => rows
          .filter((row) => String(row.SnapshotID ?? row.snapshotId) === String(snapshotId))
          .sort((a, b) => Number(a.Position ?? a.position) - Number(b.Position ?? b.position))
          .map((row) => ({ price: row.Price ?? row.price, amount: row.Amount ?? row.amount }))
        await saveOrderBookSnapshots([{
          itemId: snapshot.ItemID ?? snapshot.itemId,
          city: snapshot.City ?? snapshot.city,
          quality: snapshot.Quality ?? snapshot.quality ?? 1,
          source: snapshot.Source ?? snapshot.source ?? 'Imported',
          capturedAt: snapshot.CapturedAt ?? snapshot.capturedAt ?? new Date().toISOString(),
          note: snapshot.Note ?? snapshot.note ?? '',
          sellOrders: getOrders(sells),
          buyOrders: getOrders(buys),
          requireBothSides: false,
        }])
        snapshotCount += 1
      }
    }
    await refreshRows()
    notice.value = `Imported ${count} price observation(s) and ${snapshotCount} order book snapshot(s). Existing data was not deleted.`
  } catch (e) {
    error.value = `Could not import this workbook: ${e.message || 'invalid file'}`
  } finally {
    event.target.value = ''
  }
}
async function deleteHistory() {
  if (!window.confirm('Delete ALL locally stored price observations and order-book snapshots? Export a backup first if needed.')) return
  await clearAllObservations()
  await refreshRows()
  notice.value = 'Local price and order-book history cleared.'
}
onMounted(async () => {
  await refreshRows()
  catalog.value = await loadItemCatalog()
})
onUnmounted(() => {
  if (ocrPreviewUrl.value) URL.revokeObjectURL(ocrPreviewUrl.value)
  if (orderBookOcrPreviewUrl.value) URL.revokeObjectURL(orderBookOcrPreviewUrl.value)
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">A</div>
        <div><strong>Albion Market</strong><small>MARKET LAB</small></div>
      </div>
      <div class="server-pill"><span class="online-dot"></span> EAST SERVER</div>
      <div class="nav-label">WORKSPACE</div>
      <button class="nav-item" :class="{ active: tab === 'market' }" @click="tab = 'market'"><span>▦</span> Market explorer</button>
      <button class="nav-item" :class="{ active: tab === 'orderbook-capture' }" @click="tab = 'orderbook-capture'"><span>▤</span> Capture order book</button>
      <button class="nav-item" :class="{ active: tab === 'orderbooks' }" @click="tab = 'orderbooks'"><span>⇄</span> Order book history</button>
      <button class="nav-item" :class="{ active: tab === 'calculator' }" @click="tab = 'calculator'"><span>⌁</span> Profit calculator</button>
      <button class="nav-item" :class="{ active: tab === 'manual' }" @click="tab = 'manual'"><span>＋</span> Add manual price</button>
      <button class="nav-item" :class="{ active: tab === 'history' }" @click="tab = 'history'"><span>◷</span> Price history</button>
      <div class="sidebar-bottom">
        <div class="local-note"><span>●</span><div><strong>Local-first storage</strong><small>Saved in this browser</small></div></div>
        <small class="muted">No account or backend required.</small>
      </div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div><span class="eyebrow">ALBION ONLINE / MARKET TOOLS</span><h1>{{ tab === 'market' ? 'Market explorer' : tab === 'orderbook-capture' ? 'Capture market order book' : tab === 'orderbooks' ? 'Order book history' : tab === 'calculator' ? 'Profit calculator' : tab === 'manual' ? 'Add manual price' : 'Price history' }}</h1></div>
        <div class="top-actions"><span class="server-chip"><span class="online-dot"></span> Asia East</span><button class="btn btn-success btn-sm" @click="exportExcel">↓ Export Excel</button></div>
      </header>

      <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>
      <div v-if="notice" class="alert alert-success py-2">{{ notice }}</div>

      <template v-if="tab === 'market'">
        <section class="stats-grid">
          <div class="stat-card"><div class="stat-top"><span>Saved observations</span><span class="stat-icon blue">◷</span></div><strong>{{ allRows.length.toLocaleString() }}</strong><small>Historical price records</small></div>
          <div class="stat-card"><div class="stat-top"><span>API observations</span><span class="stat-icon purple">↗</span></div><strong>{{ apiCount.toLocaleString() }}</strong><small>Community data snapshots</small></div>
          <div class="stat-card"><div class="stat-top"><span>Manual observations</span><span class="stat-icon green">✎</span></div><strong>{{ manualCount.toLocaleString() }}</strong><small>Your own price entries</small></div>
          <div class="stat-card"><div class="stat-top"><span>Items tracked</span><span class="stat-icon amber">◇</span></div><strong>{{ uniqueItems }}</strong><small>Unique item IDs saved</small></div>
        </section>

        <section class="panel mb-4">
          <div class="panel-heading"><div><h2>Fetch market prices</h2><p>Choose item IDs, cities and qualities to request from AODP.</p></div><span class="source-tag">AODP API</span></div>
          <label class="form-label">Find items by name or ID</label>
          <div class="row g-2 mb-2">
            <div class="col-md-8">
              <input v-model="itemSearch" class="form-control" list="fetch-item-options" placeholder="Search e.g. Fiber, Sword, Horse…" />
              <datalist id="fetch-item-options"><option v-for="item in itemSearchResults" :key="item.id" :value="item.name">{{ item.id }}</option></datalist>
            </div>
            <div class="col-md-4"><button class="btn btn-outline-success w-100" @click="addItemToFetchList(catalog.find(i => i.name.toLowerCase() === itemSearch.toLowerCase() || i.id.toLowerCase() === itemSearch.toLowerCase()))">＋ Add selected item</button></div>
          </div>
          <div class="selected-items mb-3">
            <span v-for="id in itemIdsInput.split(/[\\s,;]+/).filter(Boolean)" :key="id" class="selected-item">{{ catalog.find(i => i.id === id)?.name || id }} <small>{{ id }}</small><button type="button" @click="removeFetchItem(id)" aria-label="Remove item">×</button></span>
            <span v-if="!itemIdsInput.trim()" class="muted">No items selected yet.</span>
          </div>
          <div class="small muted mb-3">The catalog loads from a public Albion item dataset when available. If offline, a starter catalog is used. You can search by display name or item ID.</div>
          <div class="row g-3">
            <div class="col-lg-8">
              <label class="form-label">Cities</label>
              <div class="choice-list">
                <label v-for="city in cities" :key="city" class="choice"><input v-model="selectedCities" type="checkbox" :value="city" /> {{ city }}</label>
              </div>
            </div>
            <div class="col-lg-4">
              <label class="form-label">Quality</label>
              <div class="choice-list quality-list"><label v-for="q in qualities" :key="q" class="choice"><input v-model="selectedQualities" type="checkbox" :value="q" /> Q{{ q }}</label></div>
              <button class="btn btn-success w-100 mt-3" :disabled="loading" @click="loadPrices">{{ loading ? 'Fetching…' : '↻ Fetch & save snapshot' }}</button>
            </div>
          </div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>Every fetch creates a new historical snapshot. API prices of 0 are shown as unavailable, not as real market prices.</span></div>
          <div v-if="lastFetched" class="last-fetched">Last successful fetch: {{ dateTime(lastFetched) }}</div>
        </section>

        <section class="panel">
          <div class="panel-heading responsive-heading"><div><h2>Latest saved prices</h2><p>Most recent observation per item, city and quality.</p></div><span class="result-count">{{ validMarketRows }} rows with at least one price</span></div>
          <div class="filters">
            <input v-model="search" class="form-control search-box" placeholder="Search item or city…" />
            <select v-model="selectedItem" class="form-select"><option value="">All items</option><option v-for="item in [...new Set(allRows.map(r => r.itemId))]" :key="item" :value="item">{{ item }}</option></select>
            <select v-model="cityFilter" class="form-select"><option>All</option><option v-for="city in cities" :key="city">{{ city }}</option></select>
            <select v-model="qualityFilter" class="form-select"><option value="All">All qualities</option><option v-for="q in qualities" :key="q" :value="String(q)">Quality {{ q }}</option></select>
          </div>
          <div class="table-responsive">
            <table class="table market-table align-middle">
              <thead><tr><th>Item / quality</th><th>City</th><th>Sell min</th><th>Buy max</th><th>Source</th><th>Observed</th><th></th></tr></thead>
              <tbody>
                <tr v-for="r in marketRows" :key="r.id">
                  <td><strong>{{ r.itemId }}</strong><small class="d-block muted">Quality {{ r.quality }}</small></td>
                  <td>{{ r.city }}</td>
                  <td class="price-cell">{{ money(r.sellMin) }}</td>
                  <td class="price-cell">{{ money(r.buyMax) }}</td>
                  <td><span class="source-tag" :class="r.source === 'Manual' ? 'manual-tag' : ''">{{ r.source }}</span></td>
                  <td><span>{{ ageLabel(r.sellMinDate || r.observedAt) }}</span><small class="d-block muted">{{ dateTime(r.observedAt) }}</small></td>
                  <td><button class="btn btn-sm btn-outline-secondary" @click="setCalculatorFromRow(r)">Use</button></td>
                </tr>
                <tr v-if="!marketRows.length"><td colspan="7" class="empty-state">No matching observations yet. Fetch prices or add your own entry.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="table-footer">Showing {{ marketRows.length }} latest rows · Historical snapshots remain saved in IndexedDB.</div>
        </section>
      </template>

      <template v-else-if="tab === 'orderbook-capture'">
        <section class="panel">
          <div class="panel-heading"><div><h2>Enter one item across multiple cities</h2><p>Add order levels manually, read a screenshot, or paste a JSON order book. All order levels are saved in the capture.</p></div><span class="source-tag">MANUAL MARKET ENTRY</span></div>
          <div class="row g-3 mb-3">
            <div class="col-md-8"><label class="form-label">Item ID</label><input v-model="orderBookForm.itemId" class="form-control" list="orderbook-item-options" placeholder="e.g. T3_FIBER" /><datalist id="orderbook-item-options"><option v-for="item in catalog" :key="item.id" :value="item.id">{{ item.name }}</option></datalist></div>
            <div class="col-md-4"><label class="form-label">Quality</label><select v-model.number="orderBookForm.quality" class="form-select"><option v-for="q in qualities" :key="q" :value="q">Quality {{ q }}</option></select></div>
          </div>
          <div class="json-import">
            <label class="form-label" for="orderbook-json">Import order book JSON</label>
            <textarea id="orderbook-json" v-model="orderBookJson" class="form-control json-input" rows="8" spellcheck="false" placeholder='{"item_id":null,"city":null,"quality":null,"captured_at":null,"sell_orders":[{"price":9,"amount":629}],"buy_orders":[{"price":9,"amount":3583}]}'></textarea>
            <div class="json-import-actions">
              <label class="json-city-label"><span class="form-label">City if JSON city is null</span><select v-model="orderBookJsonCity" class="form-select"><option v-for="city in cities" :key="`json-city-${city}`" :value="city">{{ city }}</option></select></label>
              <button class="btn btn-outline-success" @click="importOrderBookJson">Load JSON into editor</button>
            </div>
            <div class="small muted mt-2">Paste one JSON object with <code>sell_orders</code> and <code>buy_orders</code>. Null item, city, quality, or capture time use the current form, selected fallback city, quality, or current time. Supports up to {{ MAX_ORDER_BOOK_LEVELS }} levels per side; check the loaded values before saving.</div>
          </div>
          <label class="form-label">Cities to include in this capture</label>
          <div class="choice-list city-choice-list">
            <label v-for="city in cities" :key="city" class="choice">
              <input type="checkbox" :checked="selectedOrderBookCities.includes(city)" @change="toggleOrderBookCity(city)" />
              {{ city }}
            </label>
          </div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>For each city, upload that city's market screenshot with both Sell Orders and Buy Orders visible. OCR suggests up to five rows per side; verify and correct the extracted values before saving. You can also type, edit, or import JSON order levels.</span></div>
        </section>
        <input ref="orderBookPhotoInput" class="d-none" type="file" accept="image/*" @change="processOrderBookPhoto" />
        <section v-for="city in selectedOrderBookCities" :key="city" class="panel city-capture-panel">
          <div class="panel-heading responsive-heading">
            <div><h2>{{ city }}</h2><p>Sell listings and buy orders for {{ orderBookForm.itemId || 'this item' }}, Quality {{ orderBookForm.quality }}.</p></div>
            <div class="d-flex align-items-center gap-2">
              <span v-if="orderBookSources[city] === 'Screenshot'" class="source-tag manual-tag">SCREENSHOT READ</span>
              <button class="btn btn-sm btn-outline-success" :disabled="Boolean(orderBookOcrBusyCity)" @click="openOrderBookPhotoPicker(city)">
                {{ orderBookOcrBusyCity === city ? `Reading ${ocrProgress}%` : 'Read screenshot' }}
              </button>
            </div>
          </div>
          <div v-if="orderBookOcrCity === city && orderBookOcrPreviewUrl" class="ocr-review mb-3">
            <img :src="orderBookOcrPreviewUrl" :alt="`${city} market screenshot preview`" />
            <div class="ocr-text"><strong>{{ city }} screenshot text (check extracted rows below)</strong><pre>{{ orderBookOcrText || 'Recognizing text…' }}</pre></div>
          </div>
          <div class="orderbook-columns">
            <div class="order-side sell-side">
              <div class="order-side-heading"><div><h2>Sell Orders</h2><small>{{ cityOrderBooks[city].sellOrders.length }} of {{ MAX_ORDER_BOOK_LEVELS }} levels</small></div><button class="btn btn-sm btn-outline-success" :disabled="cityOrderBooks[city].sellOrders.length >= MAX_ORDER_BOOK_LEVELS" @click="addOrder(city, 'sell')">＋ Add level</button></div>
              <div v-for="(order, index) in cityOrderBooks[city].sellOrders" :key="`sell-${city}-${index}`" class="order-entry">
                <span class="order-index">{{ index + 1 }}</span>
                <label><span>Price</span><input v-model.number="order.price" type="number" min="1" step="1" class="form-control" :aria-label="`${city} sell order ${index + 1} price`" placeholder="Price" /></label>
                <label><span>Amount</span><input v-model.number="order.amount" type="number" min="1" step="any" class="form-control" :aria-label="`${city} sell order ${index + 1} amount`" placeholder="Amount" /></label>
                <button class="btn btn-sm btn-outline-danger" :disabled="cityOrderBooks[city].sellOrders.length === 1" :aria-label="`Remove ${city} sell order ${index + 1}`" @click="removeOrder(city, 'sell', index)">×</button>
              </div>
            </div>
            <div class="order-side buy-side">
              <div class="order-side-heading"><div><h2>Buy Orders</h2><small>{{ cityOrderBooks[city].buyOrders.length }} of {{ MAX_ORDER_BOOK_LEVELS }} levels</small></div><button class="btn btn-sm btn-outline-success" :disabled="cityOrderBooks[city].buyOrders.length >= MAX_ORDER_BOOK_LEVELS" @click="addOrder(city, 'buy')">＋ Add level</button></div>
              <div v-for="(order, index) in cityOrderBooks[city].buyOrders" :key="`buy-${city}-${index}`" class="order-entry">
                <span class="order-index">{{ index + 1 }}</span>
                <label><span>Price</span><input v-model.number="order.price" type="number" min="1" step="1" class="form-control" :aria-label="`${city} buy order ${index + 1} price`" placeholder="Price" /></label>
                <label><span>Amount</span><input v-model.number="order.amount" type="number" min="1" step="any" class="form-control" :aria-label="`${city} buy order ${index + 1} amount`" placeholder="Amount" /></label>
                <button class="btn btn-sm btn-outline-danger" :disabled="cityOrderBooks[city].buyOrders.length === 1" :aria-label="`Remove ${city} buy order ${index + 1}`" @click="removeOrder(city, 'buy', index)">×</button>
              </div>
            </div>
          </div>
          <button class="btn btn-sm btn-success mt-3" @click="saveOrderBook([city])">Save {{ city }} snapshot</button>
        </section>
        <button class="btn btn-success mb-4" :disabled="!selectedOrderBookCities.length" @click="saveOrderBook()">＋ Save all {{ selectedOrderBookCities.length }} city snapshots</button>
      </template>

      <template v-else-if="tab === 'orderbooks'">
        <section class="panel">
          <div class="panel-heading responsive-heading"><div><h2>Compare cities for one item</h2><p>Compare every saved sell and buy order level for the same item and quality.</p></div><span class="result-count">{{ comparedOrderBooks.length }} cities</span></div>
          <div class="filters">
            <select v-model="orderBookFilter" class="form-select">
              <option v-for="item in [...new Set(allOrderBooks.map(snapshot => snapshot.itemId))]" :key="item" :value="item">{{ item }}</option>
              <option v-if="!allOrderBooks.length" value="T3_FIBER">T3_FIBER</option>
            </select>
            <select v-model="orderBookQualityFilter" class="form-select"><option value="All">All qualities</option><option v-for="q in qualities" :key="q" :value="String(q)">Quality {{ q }}</option></select>
          </div>
          <div class="table-responsive">
            <table class="table market-table align-middle">
              <thead><tr><th>City / quality</th><th v-for="level in comparedOrderBookLevelCount" :key="`sell-head-${level}`">Sell {{ level }} · price / amount</th><th v-for="level in comparedOrderBookLevelCount" :key="`buy-head-${level}`">Buy {{ level }} · price / amount</th><th>Captured</th></tr></thead>
              <tbody>
                <tr v-for="snapshot in comparedOrderBooks" :key="snapshot.id">
                  <td><strong>{{ snapshot.city }}</strong><small class="d-block muted">Quality {{ snapshot.quality }}</small></td>
                  <td v-for="level in comparedOrderBookLevelCount" :key="`sell-${snapshot.id}-${level}`" class="depth-cell"><strong>{{ snapshot.sellOrders[level - 1] ? money(snapshot.sellOrders[level - 1].price) : '—' }}</strong><small v-if="snapshot.sellOrders[level - 1]">× {{ money(snapshot.sellOrders[level - 1].amount) }}</small></td>
                  <td v-for="level in comparedOrderBookLevelCount" :key="`buy-${snapshot.id}-${level}`" class="depth-cell"><strong>{{ snapshot.buyOrders[level - 1] ? money(snapshot.buyOrders[level - 1].price) : '—' }}</strong><small v-if="snapshot.buyOrders[level - 1]">× {{ money(snapshot.buyOrders[level - 1].amount) }}</small></td>
                  <td>{{ dateTime(snapshot.capturedAt) }}</td>
                </tr>
                <tr v-if="!comparedOrderBooks.length"><td :colspan="2 + comparedOrderBookLevelCount * 2" class="empty-state">No order books for this item and quality yet. Enter the item for one or more cities in Capture Order Book.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>Order levels are kept in the order entered. For meaningful comparison, order sell prices from lowest to highest and buy prices from highest to lowest.</span></div>
        </section>
        <section class="panel">
          <div class="panel-heading responsive-heading"><div><h2>Trade strategy analysis</h2><p>Use one trade quantity to compare every buy/sell method for each city-to-city route.</p></div></div>
          <div class="row g-3 fee-settings mb-4">
            <div class="col-md-3"><label class="form-label">Your trade quantity</label><input v-model.number="orderBookFees.quantity" type="number" min="1" step="1" class="form-control" /></div>
            <div class="col-md-3"><label class="form-label">Sell order price (optional)</label><input v-model.number="orderBookFees.sellOrderPrice" type="number" min="1" step="1" class="form-control" placeholder="Use city's lowest listing" /></div>
            <div class="col-md-4"><label class="form-label">Sell-order fee (%)</label><input v-model.number="orderBookFees.sellOrderFeePercent" type="number" min="0" max="100" step="0.1" class="form-control" /></div>
            <div class="col-md-4"><label class="form-label">Order setup fee (%)</label><input v-model.number="orderBookFees.orderSetupFeePercent" type="number" min="0" max="100" step="0.1" class="form-control" /></div>
          </div>
          <div class="small muted mb-3">Defaults: 8% sell-order fee and 1.8% setup fee per placed order. Buy orders pay setup fee only. Blank sell order price uses that destination's lowest listed sell price. Instant routes are limited by the saved market depth; order placements use your entered quantity and assume they fill.</div>
          <div class="filters route-filters" aria-label="Filter trade routes">
            <select v-model="routeBuyCityFilter" class="form-select" aria-label="Filter by buying city">
              <option value="All">All buying cities</option>
              <option v-for="city in routeCities" :key="`buy-${city}`" :value="city">{{ city }}</option>
            </select>
            <select v-model="routeSellCityFilter" class="form-select" aria-label="Filter by selling city">
              <option value="All">All selling cities</option>
              <option v-for="city in routeCities" :key="`sell-${city}`" :value="city">{{ city }}</option>
            </select>
            <select v-model="routeProfitFilter" class="form-select" aria-label="Filter by profit or loss">
              <option value="All">Profit and loss</option>
              <option value="Profit">Profitable only</option>
              <option value="Loss">Losses only</option>
              <option value="Break-even">Break-even only</option>
            </select>
            <span class="result-count">{{ filteredArbitrageRoutes.length }} routes</span>
          </div>
          <div v-if="filteredArbitrageRoutes.length" class="table-responsive">
            <table class="table market-table align-middle">
              <thead><tr><th>Strategy</th><th>Route</th><th>Qty filled / requested</th><th>Avg. buy</th><th>Avg. sell</th><th>Gross profit</th><th>Buy setup</th><th>Sell fee</th><th>Sell setup</th><th>Net profit</th></tr></thead>
              <tbody><tr v-for="route in filteredArbitrageRoutes" :key="`${route.quality}-${route.buyCity}-${route.sellCity}-${route.strategy}`"><td><strong>{{ route.strategy }}</strong><small class="d-block muted">Q{{ route.quality }}</small></td><td>{{ route.buyCity }} → {{ route.sellCity }}</td><td>{{ money(route.quantity) }} / {{ money(route.requestedQuantity) }}</td><td>{{ money(route.averageBuy) }}</td><td>{{ money(route.averageSell) }}</td><td>{{ money(route.revenue - route.invested) }}</td><td>{{ money(route.buySetupFees) }}</td><td>{{ money(route.sellFees) }}</td><td>{{ money(route.sellSetupFees) }}</td><td class="price-cell" :class="route.profit >= 0 ? 'text-success' : 'text-danger'">{{ money(route.profit) }}</td></tr></tbody>
            </table>
          </div>
          <div v-else-if="arbitrageRoutes.length" class="empty-state">No routes match these filters. Try a different city pair or profit/loss option.</div>
          <div v-else class="empty-state">No routes can be calculated yet. Save order-book data for at least two cities with the needed price levels.</div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>Every available route is shown, including losses. Instant buy uses source sell listings; buy-order estimates use the source's best existing bid as your proposed bid and include setup fee only. Instant sell uses destination buy orders; sell-order estimates use your entered price or destination's lowest sell listing, plus the sell fee and setup fee. Order placement fill is not guaranteed; travel is excluded.</span></div>
        </section>
        <section class="panel">
          <div class="panel-heading"><div><h2>Price movement over time</h2><p>Best sell and buy prices in each city compared with that city's previous saved capture.</p></div><span class="result-count">Up to 200 captures</span></div>
          <div class="table-responsive">
            <table class="table market-table align-middle">
              <thead><tr><th>Captured</th><th>City</th><th>Best sell</th><th>Change</th><th>Best buy</th><th>Change</th></tr></thead>
              <tbody>
                <tr v-for="snapshot in orderBookHistory" :key="`history-${snapshot.id}`">
                  <td>{{ dateTime(snapshot.capturedAt) }}</td>
                  <td><strong>{{ snapshot.city }}</strong></td>
                  <td>{{ snapshot.bestSell ? money(snapshot.bestSell.price) : '—' }}<small v-if="snapshot.bestSell" class="d-block muted">Amount {{ money(snapshot.bestSell.amount) }}</small></td>
                  <td :class="snapshot.sellChange > 0 ? 'text-danger' : snapshot.sellChange < 0 ? 'text-success' : ''">{{ changeLabel(snapshot.sellChange) }}</td>
                  <td>{{ snapshot.bestBuy ? money(snapshot.bestBuy.price) : '—' }}<small v-if="snapshot.bestBuy" class="d-block muted">Amount {{ money(snapshot.bestBuy.amount) }}</small></td>
                  <td :class="snapshot.buyChange > 0 ? 'text-success' : snapshot.buyChange < 0 ? 'text-danger' : ''">{{ changeLabel(snapshot.buyChange) }}</td>
                </tr>
                <tr v-if="!orderBookHistory.length"><td colspan="6" class="empty-state">Save another capture later to see each city's price movement over time.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="table-footer">A positive sell-price change means sellers are asking more; a positive buy-price change means buyers are bidding more. Changes compare with the immediately preceding saved snapshot for the same city and quality.</div>
        </section>
      </template>

      <template v-else-if="tab === 'manual'">
        <section class="panel photo-panel">
          <div class="panel-heading"><div><h2>Extract prices from a screenshot</h2><p>Upload an Albion market screenshot. OCR will try to recognize the item, city and visible numbers.</p></div><span class="source-tag">PHOTO OCR</span></div>
          <input ref="photoInput" class="d-none" type="file" accept="image/*" @change="processMarketPhoto" />
          <div class="photo-drop">
            <div class="photo-icon">▧</div>
            <div class="photo-copy"><strong>Choose a market screenshot</strong><small>PNG, JPG, or WEBP · Processed in your browser</small></div>
            <button class="btn btn-outline-success" :disabled="ocrBusy" @click="openPhotoPicker">{{ ocrBusy ? `Reading image ${ocrProgress}%` : 'Choose photo' }}</button>
          </div>
          <div v-if="ocrPreviewUrl" class="ocr-review mt-3">
            <img :src="ocrPreviewUrl" alt="Uploaded market screenshot preview" />
            <div class="ocr-text"><strong>Recognized text (for checking)</strong><pre>{{ ocrText || 'Recognizing text…' }}</pre></div>
          </div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>OCR is an assistant, not guaranteed extraction. Albion screenshots may use different layouts; check the detected item and every price before saving. Uncertain values should be corrected manually.</span></div>
        </section>
        <section class="panel form-panel">
          <div class="panel-heading"><div><h2>Record an in-game price</h2><p>Use this for a price you personally checked. This creates a new observation and does not overwrite history.</p></div><span class="source-tag manual-tag">MANUAL ENTRY</span></div>
          <form @submit.prevent="addManualPrice">
            <div class="row g-3">
              <div class="col-md-6">
                <label class="form-label">Find item by name or ID</label>
                <input v-model="itemSearch" class="form-control" list="manual-item-options" placeholder="Search Fiber, Sword, Horse…" required />
                <datalist id="manual-item-options"><option v-for="item in itemSearchResults" :key="item.id" :value="item.name">{{ item.id }}</option></datalist>
                <div class="d-flex align-items-center gap-2 mt-2"><span class="source-tag">{{ manual.itemId || 'No item selected' }}</span><button type="button" class="btn btn-sm btn-outline-success" @click="chooseManualItem(catalog.find(i => i.name.toLowerCase() === itemSearch.toLowerCase() || i.id.toLowerCase() === itemSearch.toLowerCase()))">Select item</button></div>
              </div>
              <div class="col-md-6"><label class="form-label">City</label><select v-model="manual.city" class="form-select"><option v-for="city in cities" :key="city">{{ city }}</option></select></div>
              <div class="col-md-6"><label class="form-label">Quality</label><select v-model.number="manual.quality" class="form-select"><option v-for="q in qualities" :key="q" :value="q">Quality {{ q }}</option></select></div>
              <div class="col-md-6"><label class="form-label">Sell minimum</label><input v-model="manual.sellMin" type="number" min="0" step="any" class="form-control" placeholder="e.g. 104" /></div>
              <div class="col-md-6"><label class="form-label">Sell maximum</label><input v-model="manual.sellMax" type="number" min="0" step="any" class="form-control" placeholder="Optional" /></div>
              <div class="col-md-6"><label class="form-label">Buy minimum</label><input v-model="manual.buyMin" type="number" min="0" step="any" class="form-control" placeholder="Optional" /></div>
              <div class="col-md-6"><label class="form-label">Buy maximum</label><input v-model="manual.buyMax" type="number" min="0" step="any" class="form-control" placeholder="e.g. 95" /></div>
              <div class="col-12"><label class="form-label">Notes (optional)</label><textarea v-model="manual.note" class="form-control" rows="2" placeholder="Quantity available, checked in-game, market context…"></textarea></div>
            </div>
            <button class="btn btn-success mt-4" type="submit">＋ Save historical observation</button>
          </form>
        </section>
      </template>

      <template v-else-if="tab === 'calculator'">
        <section class="panel">
          <div class="panel-heading"><div><h2>Route profit estimator</h2><p>Enter prices or use a saved row from Market Explorer. Results are estimates before travel costs.</p></div></div>
          <div class="row g-3">
            <div class="col-md-6"><label class="form-label">Item ID</label><input v-model="calc.itemId" class="form-control" /></div>
            <div class="col-md-6"><label class="form-label">Quality</label><select v-model.number="calc.quality" class="form-select"><option v-for="q in qualities" :key="q" :value="q">Quality {{ q }}</option></select></div>
            <div class="col-md-6"><label class="form-label">Buy city</label><select v-model="calc.buyCity" class="form-select"><option v-for="city in cities" :key="city">{{ city }}</option></select></div>
            <div class="col-md-6"><label class="form-label">Sell city</label><select v-model="calc.sellCity" class="form-select"><option v-for="city in cities" :key="city">{{ city }}</option></select></div>
            <div class="col-md-6"><label class="form-label">Buy price per item</label><input v-model.number="calc.buyPrice" type="number" min="0" class="form-control" /></div>
            <div class="col-md-6"><label class="form-label">{{ calc.sellMethod === 'order' ? 'Instant sell reference price' : 'Instant sell price per item' }}</label><input v-model.number="calc.sellPrice" type="number" min="0" class="form-control" /></div>
            <div class="col-md-6"><label class="form-label">Quantity</label><input v-model.number="calc.quantity" type="number" min="1" class="form-control" /></div>
            <div class="col-md-6"><label class="form-label">Buy method</label><select v-model="calc.buyMethod" class="form-select"><option value="instant">Instant buy — no order fees</option><option value="order">Place buy order</option></select></div>
            <div class="col-md-6"><label class="form-label">Sell method</label><select v-model="calc.sellMethod" class="form-select"><option value="instant">Instant sell — no order fees</option><option value="order">Place sell order</option></select></div>
            <div class="col-md-4"><label class="form-label">Sell order price (optional)</label><input v-model.number="calc.sellOrderPrice" type="number" min="1" step="1" class="form-control" :disabled="calc.sellMethod !== 'order'" placeholder="Uses sell price above" /></div>
            <div class="col-md-4"><label class="form-label">Sell-order fee (%)</label><input v-model.number="calc.sellOrderFeePercent" type="number" min="0" max="100" step="0.1" class="form-control" :disabled="calc.sellMethod !== 'order'" /></div>
            <div class="col-md-4"><label class="form-label">Order setup fee (%)</label><input v-model.number="calc.orderSetupFeePercent" type="number" min="0" max="100" step="0.1" class="form-control" :disabled="calc.buyMethod !== 'order' && calc.sellMethod !== 'order'" /></div>
          </div>
          <div class="calc-results mt-4">
            <div><small>Total purchase cost</small><strong>{{ money(calcResult.cost) }}</strong></div>
            <div><small>Estimated revenue</small><strong>{{ money(calcResult.revenue) }}</strong></div>
            <div><small>Estimated fees</small><strong>{{ money(calcResult.fees) }}</strong><small>Buy {{ money(calcResult.buyFees) }} · Sell {{ money(calcResult.sellFees) }} · Setup {{ money(calcResult.setupFees) }}</small></div>
            <div class="profit-result"><small>Estimated net profit</small><strong :class="calcResult.profit >= 0 ? 'text-success' : 'text-danger'">{{ money(calcResult.profit) }}</strong><small>Margin: {{ calcResult.margin.toFixed(2) }}%</small></div>
          </div>
          <div class="info-strip mt-3"><span>ⓘ</span><span>Buy orders have no 8% order fee; only the 1.8% setup fee applies when placing one. Sell orders default to an 8% fee plus the 1.8% setup fee. Instant buys and sells have no order/setup fees. Add transport and other costs separately.</span></div>
        </section>
      </template>

      <template v-else>
        <section class="panel">
          <div class="panel-heading responsive-heading"><div><h2>Historical observations</h2><p>Newest records first. The same item/city/quality can have many observations over time.</p></div><div class="d-flex gap-2"><button class="btn btn-outline-secondary btn-sm" @click="triggerImport">↑ Import Excel</button><button class="btn btn-outline-danger btn-sm" @click="deleteHistory">Clear history</button><input ref="importInput" class="d-none" type="file" accept=".xlsx,.xls,.csv" @change="importExcel" /></div></div>
          <div class="filters"><input v-model="search" class="form-control search-box" placeholder="Search item, city, or source…" /><button class="btn btn-success" @click="exportExcel">↓ Export .xlsx</button></div>
          <div class="table-responsive">
            <table class="table market-table align-middle">
              <thead><tr><th>Observed at</th><th>Item</th><th>City</th><th>Q</th><th>Sell min</th><th>Sell max</th><th>Buy min</th><th>Buy max</th><th>Source</th></tr></thead>
              <tbody>
                <tr v-for="r in historyRows" :key="r.id"><td>{{ dateTime(r.observedAt) }}</td><td><strong>{{ r.itemId }}</strong></td><td>{{ r.city }}</td><td>{{ r.quality }}</td><td>{{ money(r.sellMin) }}</td><td>{{ money(r.sellMax) }}</td><td>{{ money(r.buyMin) }}</td><td>{{ money(r.buyMax) }}</td><td><span class="source-tag" :class="r.source === 'Manual' ? 'manual-tag' : ''">{{ r.source }}</span></td></tr>
                <tr v-if="!historyRows.length"><td colspan="9" class="empty-state">No history saved yet. Fetch API prices or add a manual observation.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="table-footer">Showing up to 500 matching records of {{ allRows.length }} total observations. Export Excel for the complete dataset.</div>
        </section>
      </template>
      <footer class="app-footer"><span>ALBION MARKET LAB</span><span>Local data · API observations are not guaranteed to be live or complete</span></footer>
    </main>
  </div>
</template>