import axios from 'axios'

const BASE_URL = 'https://east.albion-online-data.com/api/v2/stats/prices'

export async function fetchMarketPrices({ itemIds, cities, qualities }) {
  const ids = itemIds.map((item) => item.trim()).filter(Boolean)
  if (!ids.length) throw new Error('Enter at least one item ID.')
  const params = {}
  if (cities.length) params.locations = cities.join(',')
  if (qualities.length) params.qualities = qualities.join(',')

  const response = await axios.get(`${BASE_URL}/${ids.map(encodeURIComponent).join(',')}`, {
    params,
    timeout: 25000,
  })
  if (!Array.isArray(response.data)) throw new Error('Unexpected API response. Please try again.')
  return response.data
}