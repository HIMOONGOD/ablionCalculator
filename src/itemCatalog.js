import axios from 'axios'

const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json'

export const fallbackItems = [
  ['T2_FIBER','Rough Fiber','Resources'],['T3_FIBER','Rugged Fiber','Resources'],['T4_FIBER','Thin Hide','Resources'],
  ['T2_WOOD','Birch Logs','Resources'],['T3_WOOD','Chestnut Logs','Resources'],['T4_WOOD','Pine Logs','Resources'],
  ['T2_ORE','Copper Ore','Resources'],['T3_ORE','Iron Ore','Resources'],['T4_ORE','Titanium Ore','Resources'],
  ['T2_ROCK','Limestone','Resources'],['T3_ROCK','Sandstone','Resources'],['T4_ROCK','Travertine','Resources'],
  ['T2_HIDE','Scraps of Hide','Resources'],['T3_HIDE','Rugged Hide','Resources'],['T4_HIDE','Thin Hide','Resources'],
  ['T2_PLANKS','Birch Planks','Refined'],['T3_PLANKS','Chestnut Planks','Refined'],['T4_PLANKS','Pine Planks','Refined'],
  ['T2_METALBAR','Copper Bar','Refined'],['T3_METALBAR','Bronze Bar','Refined'],['T4_METALBAR','Steel Bar','Refined'],
  ['T2_LEATHER','Stiff Leather','Refined'],['T3_LEATHER','Thick Leather','Refined'],['T4_LEATHER','Worked Leather','Refined'],
  ['T2_CLOTH','Simple Cloth','Refined'],['T3_CLOTH','Neat Cloth','Refined'],['T4_CLOTH','Fine Cloth','Refined'],
  ['T2_BAG','Novice’s Bag','Equipment'],['T3_BAG','Journeyman’s Bag','Equipment'],['T4_BAG','Adept’s Bag','Equipment'],
  ['T2_CAPE','Novice’s Cape','Equipment'],['T3_CAPE','Journeyman’s Cape','Equipment'],['T4_CAPE','Adept’s Cape','Equipment'],
  ['T4_MAIN_SWORD','Adept’s Broadsword','Weapons'],['T4_MAIN_AXE','Adept’s Battleaxe','Weapons'],
  ['T4_MAIN_SPEAR','Adept’s Spear','Weapons'],['T4_MAIN_BOW','Adept’s Bow','Weapons'],
  ['T4_MAIN_FIRESTAFF','Adept’s Fire Staff','Weapons'],['T4_MAIN_FROSTSTAFF','Adept’s Frost Staff','Weapons'],
  ['T4_MAIN_HOLYSTAFF','Adept’s Holy Staff','Weapons'],['T4_MAIN_CURSEDSTAFF','Adept’s Cursed Staff','Weapons'],
  ['T4_HEAD_CLOTH_SET1','Adept’s Scholar Cowl','Armor'],['T4_ARMOR_CLOTH_SET1','Adept’s Scholar Robe','Armor'],
  ['T4_SHOES_CLOTH_SET1','Adept’s Scholar Sandals','Armor'],['T4_HEAD_LEATHER_SET1','Adept’s Mercenary Hood','Armor'],
  ['T4_ARMOR_LEATHER_SET1','Adept’s Mercenary Jacket','Armor'],['T4_SHOES_LEATHER_SET1','Adept’s Mercenary Shoes','Armor'],
  ['T4_HEAD_PLATE_SET1','Adept’s Soldier Helmet','Armor'],['T4_ARMOR_PLATE_SET1','Adept’s Soldier Armor','Armor'],
  ['T4_SHOES_PLATE_SET1','Adept’s Soldier Boots','Armor'],['T4_MEAL_OMELETTE','Pork Omelette','Consumables'],
  ['T4_MEAL_STEW','Beef Stew','Consumables'],['T4_POTION_HEAL','Healing Potion','Consumables'],
  ['T4_POTION_ENERGY','Energy Potion','Consumables'],['T4_MOUNT_HORSE','Journeyman’s Riding Horse','Mounts'],
  ['T3_MOUNT_HORSE','Novice’s Riding Horse','Mounts'],['T4_MOUNT_OX','Journeyman’s Transport Ox','Mounts'],
]

function englishName(entry) {
  const names = entry.LocalizedNames || entry.localizedNames || entry.Names || {}
  return names['EN-US'] || names['EN-GB'] || names['en-US'] || names['en'] ||
    entry.Name || entry.name || entry.UniqueName || entry.uniqueName || ''
}

function normalizeEntry(entry) {
  const id = entry.UniqueName || entry.uniqueName || entry.ItemId || entry.itemId || entry.id
  const name = englishName(entry)
  if (!id || !name || typeof id !== 'string' || !/^[A-Z0-9_@-]+$/i.test(id)) return null
  if (entry.IsLoot || entry.isLoot || entry.HideFromMarket || entry.hideFromMarket) return null
  return { id, name: String(name), category: entry.Category || entry.category || 'Other' }
}

export async function loadItemCatalog() {
  try {
    const response = await axios.get(REMOTE_CATALOG_URL, { timeout: 12000 })
    const raw = Array.isArray(response.data) ? response.data : Object.values(response.data || {})
    const parsed = raw.map(normalizeEntry).filter(Boolean)
    if (parsed.length > 100) {
      const unique = new Map(parsed.map((item) => [item.id, item]))
      return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch (error) {
    console.warn('Could not load remote Albion item catalog; using built-in starter catalog.', error)
  }
  return fallbackItems.map(([id, name, category]) => ({ id, name, category }))
}
