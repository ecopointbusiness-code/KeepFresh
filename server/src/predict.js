import { all, get } from './db.js';
import { addDays } from './util.js';

/**
 * AI-based shelf-life prediction.
 * 1. Start from the admin-managed default shelf life of the food category.
 * 2. Learn from this household's own history (how many days items of the category
 *    actually lasted before being used or thrown away) and blend it in.
 *    The more history, the more weight it gets (up to 60%).
 */
export async function predictExpiry(householdId, category, bought) {
  const row = await get('SELECT shelf_days FROM food_catalog WHERE category=?', category);
  const base = row ? row.shelf_days : 7;
  const hist = await all('SELECT days FROM consumption_logs WHERE household_id=? AND category=? ORDER BY id DESC LIMIT 20', householdId, category);
  let days = base, confidence = 0.5;
  if (hist.length) {
    const avg = hist.reduce((a, h) => a + h.days, 0) / hist.length;
    const w = Math.min(0.6, hist.length * 0.1);
    days = Math.max(1, Math.round((1 - w) * base + w * avg));
    confidence = Math.min(0.95, 0.5 + hist.length * 0.05);
  }
  return { expires: addDays(bought, days), days, base, samples: hist.length, confidence: Number(confidence.toFixed(2)) };
}

export function guessCategory(name) {
  const n = name.toLowerCase();
  const rules = [
    ['Poultry', /chicken|manok|turkey|duck/], ['Ground meat', /ground|giniling|minced/], ['Pork or beef cuts', /pork|beef|baboy|baka|liempo|steak/],
    ['Fish & seafood', /fish|isda|shrimp|hipon|tilapia|bangus|squid|crab/], ['Leafy vegetables', /kangkong|malunggay|lettuce|spinach|pechay|cabbage|tomato|ampalaya/],
    ['Dairy', /milk|cheese|butter|yogurt|cream/], ['Eggs', /\begg/],
  ];
  for (const [c, re] of rules) if (re.test(n)) return c;
  return 'Other';
}
