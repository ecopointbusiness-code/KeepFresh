import { get, run, insert, tx, dbKind } from './db.js';
import { hashPassword } from './util.js';

const CATALOG = [['Ground meat', 2, '🥩'], ['Poultry', 2, '🍗'], ['Fish & seafood', 2, '🐟'], ['Pork or beef cuts', 4, '🥓'], ['Leafy vegetables', 5, '🥬'], ['Dairy', 7, '🥛'], ['Eggs', 21, '🥚'], ['Leftovers', 3, '🍱'], ['Other', 7, '🧺']];
const RECIPES = [
  ['Chicken Adobo', '🍗', '#fde3e3', '45 min', 4, [['chicken', '1 kg chicken, cut into pieces'], ['soy sauce', '1/3 cup soy sauce'], ['vinegar', '1/4 cup vinegar'], ['garlic', '1 head garlic, crushed'], ['bay leaves', '3 bay leaves'], ['peppercorn', '1 tsp whole peppercorn'], ['salt', 'Salt to taste']],
    ['Marinate the chicken in the soy sauce and crushed garlic for 20 minutes.', 'Heat a little oil in a pot and brown the chicken on all sides.', 'Pour in the marinade, vinegar, bay leaves, and peppercorn. Let it boil without stirring.', 'Cover and simmer for 25 minutes until the chicken is tender.', 'Uncover and let the sauce reduce. Add salt if needed and serve with hot rice.']],
  ['Sinigang na Baboy', '🍲', '#fff0c9', '50 min', 4, [['pork', '500 g pork, cut into chunks'], ['tamarind mix', '1 pack tamarind (sinigang) mix'], ['kangkong', '1 bundle kangkong'], ['tomato', '2 tomatoes, quartered'], ['onion', '1 onion, quartered'], ['fish sauce', '2 tbsp fish sauce']],
    ['Boil 1.5 liters of water, then add the pork, onion, and tomato. Skim the scum.', 'Simmer for 35 minutes until the pork is tender.', 'Stir in the tamarind mix and fish sauce.', 'Add the kangkong and cook for 2 minutes.', 'Taste, adjust with fish sauce, and serve hot.']],
  ['Tinolang Manok', '🥘', '#dff5e3', '40 min', 4, [['chicken', '1 kg chicken, cut up'], ['ginger', '1 thumb ginger, sliced'], ['malunggay', '2 cups malunggay leaves'], ['onion', '1 onion, sliced'], ['fish sauce', '2 tbsp fish sauce'], ['salt', 'Salt to taste']],
    ['Sauté the ginger and onion in a little oil until fragrant.', 'Add the chicken and cook until lightly browned.', 'Add the fish sauce and 4 cups of water. Simmer for 30 minutes.', 'Add the malunggay and cook for 2 minutes.', 'Season with salt and serve with the broth.']],
  ['Pritong Isda', '🐟', '#dcedfb', '20 min', 2, [['fish', '2 fish, cleaned'], ['salt', '1 tsp salt'], ['garlic', '4 cloves garlic, minced'], ['cooking oil', '1/2 cup cooking oil']],
    ['Pat the fish dry and rub it with salt.', 'Heat the oil until it shimmers.', 'Fry the fish 4 to 5 minutes per side until golden and crisp.', 'Fry the garlic in the same oil until golden for a topping.', 'Drain on paper towels and serve.']],
  ['Egg Fried Rice', '🍳', '#fff3cf', '15 min', 2, [['egg', '3 eggs'], ['rice', '3 cups cooked rice, cold'], ['garlic', '3 cloves garlic, minced'], ['onion', '1 onion, chopped'], ['salt', 'Salt to taste']],
    ['Scramble the eggs, then set them aside.', 'Sauté the garlic and onion until fragrant.', 'Add the rice, break up the clumps, and stir-fry for 3 minutes.', 'Return the eggs, season with salt, and toss.', 'Serve hot.']],
  ['Tortang Giniling', '🍳', '#fde1e8', '25 min', 3, [['ground', '300 g ground pork'], ['egg', '3 eggs'], ['onion', '1 onion, chopped'], ['garlic', '3 cloves garlic, minced'], ['salt', 'Salt and pepper to taste']],
    ['Sauté the garlic and onion, then cook the ground pork until browned.', 'Season with salt and pepper and let it cool slightly.', 'Beat the eggs and mix in the cooked pork.', 'Pan-fry the mixture for 3 minutes per side until golden.', 'Serve with rice and banana ketchup.']],
];

export async function seed() {
  await tx(async () => {
    if (!(await get('SELECT 1 x FROM food_catalog LIMIT 1'))) for (const c of CATALOG) await run('INSERT INTO food_catalog (category, shelf_days, emoji) VALUES (?,?,?)', ...c);
    if (!(await get('SELECT 1 x FROM recipes LIMIT 1'))) for (const [n, e, col, t, s, ings, steps] of RECIPES) {
      const id = await insert('INSERT INTO recipes (name,emoji,color,time,servings,steps) VALUES (?,?,?,?,?,?)', n, e, col, t, s, JSON.stringify(steps));
      for (const [k, a] of ings) await run('INSERT INTO recipe_ings (recipe_id,key,amount) VALUES (?,?,?)', id, k, a);
    }
    const email = (process.env.ADMIN_EMAIL || 'admin@keepfresh.local').toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || 'Keepfresh@2026';
    const a = await get('SELECT * FROM users WHERE email=?', email);
    if (!a) await run("INSERT INTO users (name,email,password_hash,role,verified) VALUES ('Administrator',?,?,'admin',1)", email, hashPassword(pw));
    else if (a.role === 'admin') await run('UPDATE users SET password_hash=?, active=1, verified=1 WHERE id=?', hashPassword(pw), a.id);
    console.log(`\n  Database: ${dbKind}\n  Admin portal: /admin\n    email:    ${email}\n    password: ${process.env.ADMIN_PASSWORD ? '(set in ADMIN_PASSWORD)' : pw}\n`);
  });
}
