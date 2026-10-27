# Albion Market Lab — Vue-only starter

A local-first Albion Online market research app. No Laravel or server database is required.

## Stack
- Vue 3 + Vite
- JavaScript
- Bootstrap 5
- Axios for AODP requests
- Dexie / IndexedDB for local history
- SheetJS (`xlsx`) for Excel import/export

## Run it
1. Install Node.js (LTS).
2. Extract this project.
3. Open a terminal in the project folder.
4. Run:

```bash
npm install
npm run dev
```

5. Open the local URL Vite prints, usually `http://localhost:5173`.

## How storage works
- Each successful API fetch is saved as a separate observation in browser IndexedDB.
- Manual entries are also saved as observations and marked `Manual`.
- Market order-book captures are saved as snapshots with individual sell and buy order prices and amounts.
- Old observations are kept; new observations do not overwrite them.
- Export price history and order books as an `.xlsx` workbook. Order books use separate `Snapshots`, `Sell Orders`, and `Buy Orders` sheets.
- Import a previously exported `.xlsx` file to restore/merge price observations and order-book snapshots.
- Browser storage is local to this browser/profile. Export backups regularly.

## API
The app calls the East server:
`https://east.albion-online-data.com/api/v2/stats/prices/{itemIds}`

It requests selected cities and qualities. AODP prices are community-submitted observations and may be missing, stale, or zero. The app treats zero prices as unavailable and displays source timestamps.

## Important profit assumptions
Order-book analysis compares saved city snapshots and calculates every instant/order buy and sell combination for each city route, including unprofitable outcomes. The entered trade quantity caps each calculation; instant fills are further limited by saved order-book depth. Instant buying uses sell listings; instant selling uses buy orders, with no order fees. Placing a buy order uses the city's best existing bid as an estimate of your bid price and incurs only the adjustable setup fee (default 1.8%); there is no 8% buy-order fee. Placing a sell order uses the chosen price (or the city's lowest listed sell price by default) and applies the adjustable sell-order fee (default 8%) plus the adjustable setup fee (default 1.8%). Order-placement projections assume your orders eventually fill and are not guaranteed. Estimates exclude transport and execution risk.

## Notes
- If the API request fails due to network/CORS/API availability, the rest of the app and local history should still work.
- Keep the app open to fetch new API prices. This frontend-only app does not run background jobs while closed.


## Item catalog and screenshot OCR
- Search item names or IDs instead of remembering IDs.
- The app attempts to load a public item catalog and falls back to a small built-in catalog if the network/source is unavailable.
- In Manual Price, upload an in-game screenshot. Tesseract.js OCR runs in the browser and suggests item/city/price values when recognizable.
- In Capture Order Book, select an item and quality, then enter sell-order and buy-order price/amount levels for each city you select. Up to 50 levels per side are supported and all selected cities are saved with one capture timestamp.
- Paste a single JSON object with `item_id`, `city`, `quality`, `captured_at`, `sell_orders`, and `buy_orders` into the JSON importer. Null metadata uses the current item/quality form, selected fallback city, and current time. Review the loaded levels before saving.
- Each city also has a `Read screenshot` action for that city's in-game market view. OCR suggests up to five rows per side; review and fix any blank or mistaken values before saving the city snapshot. You may save cities individually or save all selected cities together.
- Order Book History compares all saved levels (up to 50 per side) for the same item across cities, shows historical best-price changes, and estimates all four combinations of instant/order buy and sell for each route. Enter your desired trade quantity; instant trade quantities are capped by recorded depth. Results include profits and losses.
- Instant trades have no order/setup fees; buy orders pay only the editable 1.8% default setup fee, while sell orders use editable 8% sell and 1.8% setup fee defaults.
- OCR is only a suggestion. It runs locally in the browser and never saves a snapshot until you confirm it.
