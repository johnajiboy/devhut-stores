'use strict';

/* ==========================================================================
   Devhut Stores — app.js (vanilla JS, no build step)

   1. Config            5. Rendering: grid, cards, filters
   2. Product data      6. Rendering: product, cart, wishlist, checkout
   3. Utilities         7. Routing
   4. State & stores    8. Events & init

   Data: products, categories and orders live in Supabase (see setup.sql).
   Security note: all dynamic text is inserted with textContent / DOM APIs.
   innerHTML is never used with user input anywhere in this file.
   ========================================================================== */

/* -------------------------------------------------------------------------
   1. CONFIG
   ------------------------------------------------------------------------- */
const STORAGE_KEYS = Object.freeze({
  cart: 'devhut:cart:v1',
  wishlist: 'devhut:wishlist:v1',
  theme: 'devhut:theme',
  currency: 'devhut:currency',
  lastOrder: 'devhut:last-order:v1',
});

const FREE_SHIPPING_THRESHOLD = 100;
const DELIVERY_OPTIONS = Object.freeze({
  standard: { label: 'Standard delivery', fee: 5.99, days: [3, 5] },
  express: { label: 'Express delivery', fee: 14.99, days: [1, 2] },
});
const PAYMENT_LABELS = Object.freeze({ cod: 'Pay on delivery', card: 'Card (demo)' });
const MAX_QTY_PER_LINE = 10;
const LOAD_DELAY_MS = 500;           // simulated network delay for the skeleton state
const DESKTOP_QUERY = window.matchMedia('(min-width: 960px)');

// Currency ------------------------------------------------------------------
// Prices are stored (and the server checks totals) in USD. Everything else is
// a display-only conversion using the rate the admin sets for that currency.
const BASE_CURRENCY = 'USD';
const CURRENCY_LOCALES = {
  USD: 'en-US', GBP: 'en-GB', EUR: 'en-IE', CAD: 'en-CA',
  NGN: 'en-NG', GHS: 'en-GH', KES: 'en-KE', ZAR: 'en-ZA',
};
let CURRENCIES = [{ code: BASE_CURRENCY, name: 'US Dollar', rate: 1, enabled: true, sort: 0 }];
let currentCurrency = BASE_CURRENCY;
const currencyFormatters = new Map();

function currentRate() {
  return CURRENCIES.find((c) => c.code === currentCurrency)?.rate ?? 1;
}

function formatPrice(value) {
  let formatter = currencyFormatters.get(currentCurrency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(CURRENCY_LOCALES[currentCurrency] ?? 'en-US', { style: 'currency', currency: currentCurrency });
    } catch {
      formatter = null;
    }
    currencyFormatters.set(currentCurrency, formatter);
  }
  const converted = value * currentRate();
  return formatter ? formatter.format(converted) : `${currentCurrency} ${converted.toFixed(2)}`;
}

function setCurrencies(rows) {
  const enabled = rows.filter((c) => c.enabled).sort((a, b) => a.sort - b.sort);
  CURRENCIES = enabled.length ? enabled : [{ code: BASE_CURRENCY, name: 'US Dollar', rate: 1, enabled: true, sort: 0 }];
  const stored = readStorage(STORAGE_KEYS.currency, null);
  currentCurrency = CURRENCIES.some((c) => c.code === stored) ? stored : (CURRENCIES.some((c) => c.code === BASE_CURRENCY) ? BASE_CURRENCY : CURRENCIES[0].code);
}

// Supabase client (library loaded from CDN in index.html, keys in config.js)
const CONFIG = window.DEVHUT_CONFIG ?? {};
const isConfigured = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && !CONFIG.supabaseUrl.includes('YOUR-PROJECT'));
const db = isConfigured && window.supabase ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
  // PKCE keeps OAuth/email links out of the URL hash (the hash is the router).
  // A separate storage key stops the admin page's sign-out from ending shopper sessions.
  auth: { flowType: 'pkce', storageKey: 'devhut-shop-auth' },
}) : null;

/* -------------------------------------------------------------------------
   2. PRODUCT DATA (loaded from Supabase)
   Product shape used by the UI:
   { id, name, brand, category, price, oldPrice, rating, reviews, stock,
     featured, isNew, images[], description, highlights[], variants[] }
   variants: [{ name, options: [{ label, delta? }] }]  (delta adjusts price)
   ------------------------------------------------------------------------- */
let CATEGORIES = [];
let PRODUCTS = [];
let PRODUCT_MAP = new Map();
let CATEGORY_MAP = new Map();

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand ?? '',
    category: row.category,
    price: Number(row.price),
    oldPrice: row.old_price == null ? null : Number(row.old_price),
    rating: Number(row.rating ?? 0),
    reviews: Number(row.reviews ?? 0),
    stock: Number(row.stock ?? 0),
    featured: Number(row.featured ?? 100),
    isNew: Boolean(row.is_new),
    images: Array.isArray(row.images) ? row.images.filter(Boolean) : [],
    description: row.description ?? '',
    highlights: Array.isArray(row.highlights) ? row.highlights : [],
    variants: Array.isArray(row.variants) ? row.variants.filter((v) => v?.name && v.options?.length) : [],
  };
}

function setCatalog(categories, products) {
  CATEGORIES = categories;
  PRODUCTS = products;
  CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));
  PRODUCT_MAP = new Map(PRODUCTS.map((p) => [p.id, p]));
  // Pre-compute lowercase search text once so filtering stays cheap
  PRODUCTS.forEach((p) => {
    p.searchText = [p.name, p.brand, CATEGORY_MAP.get(p.category)?.label ?? '', p.description].join(' ').toLowerCase();
  });
  cardCache.clear();
}

async function fetchCatalog() {
  if (!db) throw new Error('The store isn’t connected yet. Add your Supabase URL and anon key to config.js.');
  const [categories, products, currencies] = await Promise.all([
    db.from('categories').select('id, label, emoji, sort').order('sort'),
    db.from('products').select('*').eq('active', true),
    db.from('currencies').select('code, name, rate, enabled, sort'),
  ]);
  if (categories.error) throw categories.error;
  if (products.error) throw products.error;
  if (currencies.error) throw currencies.error;
  setCatalog(categories.data, products.data.map(mapProduct));
  setCurrencies(currencies.data);
}

const PRICE_PRESETS = [
  { min: null, max: 25 },
  { min: 25, max: 100 },
  { min: 100, max: 500 },
  { min: 500, max: null },
];

function presetLabel({ min, max }) {
  if (min == null) return `Under ${formatPrice(max)}`;
  if (max == null) return `Over ${formatPrice(min)}`;
  return `${formatPrice(min)} to ${formatPrice(max)}`;
}

/* -------------------------------------------------------------------------
   3. UTILITIES
   ------------------------------------------------------------------------- */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round2 = (n) => Math.round(n * 100) / 100;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Tiny element builder. Children may be nodes, strings (inserted as text) or arrays.
 * `text` sets textContent; `on*` functions become event listeners.
 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage full or blocked (e.g. private mode). The app keeps working in memory. */
  }
}

/* Images ------------------------------------------------------------------
   Unsplash URLs get resized on the fly; uploaded images are used as-is. */
const isUnsplash = (url) => /^https:\/\/images\.unsplash\.com\//.test(url);

/* Unsplash photo credits, required by Unsplash's API guidelines for hotlinked
   photos: keyed by the raw image URL (before sizedImage adds resize params).
   Covers every photo in the extra catalogue seeded from seed_products.sql
   (256 of its 264 products; the other 8 show a category placeholder instead
   of a photo). The original 18 sample products don't have an entry here, so
   the credit UI stays hidden for them rather than guessing. */
const PHOTO_CREDITS = {
  'https://images.unsplash.com/photo-1600271886742-f049cd451bba': { name: 'ABHISHEK HAJARE', username: 'abhishek_hajare' },
  'https://images.unsplash.com/photo-1762681290673-ba1ad4ea0875': { name: 'giuse', username: 'giusedr' },
  'https://images.unsplash.com/photo-1583508915901-b5f84c1dcde1': { name: 'Luke Peters', username: 'lukepeters' },
  'https://images.unsplash.com/photo-1547658718-1cdaa0852790': { name: 'Daniel Korpai', username: 'danielkorpai' },
  'https://images.unsplash.com/photo-1545665277-5937489579f2': { name: 'Joshua Aragon', username: 'goshua13' },
  'https://images.unsplash.com/photo-1613221699807-4940ba9b83f4': { name: 'Sara Julie', username: 'sarahjulia' },
  'https://images.unsplash.com/photo-1548486354-1b48379fd7a7': { name: 'mknd', username: 'm_k_nd' },
  'https://images.unsplash.com/photo-1610056494249-5d7f111cf78f': { name: 'Kelly Sikkema', username: 'kellysikkema' },
  'https://images.unsplash.com/photo-1594915440248-1e419eba6611': { name: 'Kirill Sh', username: 'kirill2020' },
  'https://images.unsplash.com/photo-1484506399805-c273b8e91dce': { name: 'Jakob Owens', username: 'jakobowens1' },
  'https://images.unsplash.com/photo-1684841566323-24a0a9961f19': { name: 'engin akyurt', username: 'enginakyurt' },
  'https://images.unsplash.com/photo-1610398752800-146f269dfcc8': { name: 'Alex Quezada', username: 'alex_quezada' },
  'https://images.unsplash.com/photo-1516177609387-9bad55a45194': { name: 'Frame Kings', username: 'framekings' },
  'https://images.unsplash.com/photo-1567473810954-507d59716c25': { name: 'Daniel Schludi', username: 'schluditsch' },
  'https://images.unsplash.com/photo-1527515673510-8aa78ce21f9b': { name: 'No Revisions', username: 'norevisions' },
  'https://images.unsplash.com/photo-1767214223592-f8d280efa7cf': { name: 'Brett Jordan', username: 'brett_jordan' },
  'https://images.unsplash.com/photo-1683570687112-90cbc0fd5019': { name: 'Giorgio Trovato', username: 'giorgiotrovato' },
  'https://images.unsplash.com/photo-1720534490358-bc2ad29d51d5': { name: 'Dmitry Kropachev', username: 'kropachev' },
  'https://images.unsplash.com/photo-1559312379-6eff3ba65888': { name: 'Isaac Smith', username: 'isaacmsmith' },
  'https://images.unsplash.com/photo-1471880504582-cf7e63045303': { name: 'DAVIDCOHEN', username: 'davcohpho' },
  'https://images.unsplash.com/photo-1547104442-044448b73426': { name: 'Sincerely Media', username: 'sincerelymedia' },
  'https://images.unsplash.com/photo-1628483211662-9bcc692c46dc': { name: 'Konstantin Evdokimov', username: 'constantinevdokimov' },
  'https://images.unsplash.com/photo-1772683709386-c9fc6e24c6db': { name: 'Shawn Rain', username: 'shawn_rain' },
  'https://images.unsplash.com/photo-1558584673-c834fb1cc3ca': { name: 'Victrola Record Players', username: 'victrola' },
  'https://images.unsplash.com/photo-1491637639811-60e2756cc1c7': { name: 'Jakob Owens', username: 'jakobowens1' },
  'https://images.unsplash.com/photo-1784715435231-5547da837fa9': { name: 'Ansis Kančs', username: 'ansisansis' },
  'https://images.unsplash.com/photo-1591397932448-e68f94f11b44': { name: 'Perry Fel', username: 'perryfel' },
  'https://images.unsplash.com/photo-1511794322962-129ddbd0af38': { name: 'Miguel Carraça', username: 'mcmiles' },
  'https://images.unsplash.com/photo-1637739699971-7d4d5194e75c': { name: 'Anshu A', username: 'anshu18' },
  'https://images.unsplash.com/photo-1617019114583-affb34d1b3cd': { name: 'YASU SHOTS', username: 'yasushots' },
  'https://images.unsplash.com/photo-1574405345169-f45c7d66480e': { name: 'Markus Spiske', username: 'markusspiske' },
  'https://images.unsplash.com/photo-1645453014403-4ad5170a386c': { name: 'Some Tale', username: 'some_tale' },
  'https://images.unsplash.com/photo-1551807306-4bcd16b92a41': { name: 'Angèle Kamp', username: 'angelekamp' },
  'https://images.unsplash.com/photo-1749105862005-6e0409c8c55a': { name: 'Gaia&Co', username: 'gaiacoffee' },
  'https://images.unsplash.com/photo-1622021142947-da7dedc7c39a': { name: 'Pylyp Sukhenko', username: 'novokayn' },
  'https://images.unsplash.com/photo-1644432757699-bb5a01e8fb0e': { name: 'Karyna Panchenko', username: 'karyna_panchenko' },
  'https://images.unsplash.com/photo-1676817167465-38a0fe938c53': { name: 'bader photographer', username: 'br_pic1' },
  'https://images.unsplash.com/photo-1653174577821-9ab410d92d44': { name: 'Gabre Cameron', username: 'gabrecameron' },
  'https://images.unsplash.com/photo-1511680059018-e7cc6c0f22c8': { name: 'Jakob Owens', username: 'jakobowens1' },
  'https://images.unsplash.com/photo-1515965230482-0b9b46fbee14': { name: 'Joan MM', username: 'joanmm' },
  'https://images.unsplash.com/photo-1609702847389-b8aec1b0b929': { name: 'Sandy Kawadkar', username: 'sandy_kawadkar' },
  'https://images.unsplash.com/photo-1561112078-7d24e04c3407': { name: 'Editors Keys', username: 'editorskeys' },
  'https://images.unsplash.com/photo-1606902965551-dce093cda6e7': { name: 'Julia Rekamie', username: 'juliarekamie' },
  'https://images.unsplash.com/photo-1518709414768-a88981a4515d': { name: 'Sidney Pearce', username: 'sid_pearce' },
  'https://images.unsplash.com/photo-1765970101654-337b573142fb': { name: 'Dreame Vacuum Cleaner', username: 'dreametech' },
  'https://images.unsplash.com/photo-1625910513413-c23b8bb81cba': { name: 'Clément Vatte', username: 'clement_vatte' },
  'https://images.unsplash.com/photo-1578587018452-892bacefd3f2': { name: 'Matas Katinas', username: 'matuxee' },
  'https://images.unsplash.com/photo-1620786514669-06e2340fce71': { name: 'Maryam Nemati', username: 'maryamnemati' },
  'https://images.unsplash.com/photo-1645517976245-569a91016f79': { name: 'Uliana Kopanytsia', username: 'ulian_ka' },
  'https://images.unsplash.com/photo-1543376798-62217a8d85cc': { name: 'Luísa Schetinger', username: 'luschetinger' },
  'https://images.unsplash.com/photo-1523035274455-b2e5c6d5c2e0': { name: 'Monika Grabkowska', username: 'moniqa' },
  'https://images.unsplash.com/photo-1765959106936-851735565c12': { name: 'leoon liang', username: 'leoonliang' },
  'https://images.unsplash.com/photo-1590251024078-8a6d9f90b02d': { name: 'Lisa Amann', username: 'lisaamann' },
  'https://images.unsplash.com/photo-1527016021513-b09758b777bd': { name: 'James Balensiefen', username: 'balensiefenphoto' },
  'https://images.unsplash.com/photo-1574269909862-7e1d70bb8078': { name: 'Marcos Ramírez', username: 'marcosramirez_x' },
  'https://images.unsplash.com/photo-1623990671462-0aa112e1ed32': { name: 'Alan Rodriguez', username: 'alanrodriguez' },
  'https://images.unsplash.com/photo-1417976737285-aea15c203d4a': { name: 'Maria Molinero', username: 'mariamolinero' },
  'https://images.unsplash.com/photo-1593449651257-d220669b9e7e': { name: 'Oscar Ivan Esquivel Arteaga', username: 'oscaresquivel' },
  'https://images.unsplash.com/photo-1557376382-e96b6778ffdc': { name: 'Mark Chan', username: 'markcjn' },
  'https://images.unsplash.com/photo-1567760047994-7e5e9b3272b4': { name: 'Mason Summers', username: '_masonsummers' },
  'https://images.unsplash.com/photo-1473968512647-3e447244af8f': { name: 'Jason Mavrommatis', username: 'jasonblackeye' },
  'https://images.unsplash.com/photo-1542728929-2b5d9a0c8d48': { name: 'Sincerely Media', username: 'sincerelymedia' },
  'https://images.unsplash.com/photo-1532104041590-1046d1a28c64': { name: 'Perfecto Capucine', username: 'perfecto_capucine' },
  'https://images.unsplash.com/photo-1565151443833-29bf2ba5dd8d': { name: 'Ronan Furuta', username: 'ronan18' },
  'https://images.unsplash.com/photo-1722654583863-6116ec8f247a': { name: 'Julia Perera', username: 'jules_unsplash' },
  'https://images.unsplash.com/flagged/photo-1561023367-4431103a484f': { name: 'Florian Berger', username: 'bergerteam' },
  'https://images.unsplash.com/photo-1475296204602-08d15839e95f': { name: 'GC Libraries Creative Tech Lab', username: 'goldcoastmedialab' },
  'https://images.unsplash.com/photo-1593359677879-a4bb92f829d1': { name: 'Nicolas J Leclercq', username: 'nicolasjleclercq' },
  'https://images.unsplash.com/photo-1581701663554-291c6c9e56d2': { name: 'Brent Ninaber', username: 'brentninaber' },
  'https://images.unsplash.com/photo-1552493512-cda1df4e3b62': { name: 'Tim-Oliver Metz', username: 'to_metz' },
  'https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85': { name: 'David van Dijk', username: 'dvandijk' },
  'https://images.unsplash.com/photo-1759992878340-665575a0832e': { name: 'Reistor', username: 'reistor' },
  'https://images.unsplash.com/photo-1594303471920-b66b769a6b8f': { name: 'Alessio Billeci', username: 'billimichiamo' },
  'https://images.unsplash.com/photo-1570050785780-3c79854c7813': { name: 'Armand Khoury', username: 'armand_khoury' },
  'https://images.unsplash.com/photo-1513519245088-0e12902e5a38': { name: 'Jonny Caspari', username: 'jonnycspr' },
  'https://images.unsplash.com/photo-1506976785307-8732e854ad03': { name: 'Erol Ahmed', username: 'erol' },
  'https://images.unsplash.com/photo-1708127368781-cd5f069a90a5': { name: 'Hrushi Chavhan', username: 'hcphotos' },
  'https://images.unsplash.com/photo-1641320487573-479720290849': { name: 'Cosmin Ursea', username: 'cosminursea' },
  'https://images.unsplash.com/photo-1586182987320-4f376d39d787': { name: 'Luis Villasmil', username: 'villxsmil' },
  'https://images.unsplash.com/photo-1566055972289-c52022ae23b7': { name: 'Fazly Shah', username: 'fazlyshah' },
  'https://images.unsplash.com/photo-1616296425622-4560a2ad83de': { name: 'Nerfee Mirandilla', username: 'nerfee' },
  'https://images.unsplash.com/photo-1485627658391-1365e4e0dbfe': { name: 'Irene Dávila', username: 'irenedavila' },
  'https://images.unsplash.com/photo-1760368104013-3a52a7f4e07b': { name: 'Ignat Kushnarev', username: 'ignatkushanrev' },
  'https://images.unsplash.com/photo-1553747069-aefa5a5c9bad': { name: 'Mae Mu', username: 'picoftasty' },
  'https://images.unsplash.com/photo-1593335663758-4da70281a917': { name: 'Colin Roe', username: 'coileain' },
  'https://images.unsplash.com/photo-1622798337764-259682f03741': { name: 'Rens D', username: 'rens23' },
  'https://images.unsplash.com/photo-1768729340164-7d83fe18384d': { name: 'iKshana Productions', username: 'ikshanaproductions' },
  'https://images.unsplash.com/photo-1654064754916-e3edeb09c042': { name: 'dada design', username: 'dada_design' },
  'https://images.unsplash.com/photo-1574269910231-bc508bcb68ae': { name: 'Marcos Ramírez', username: 'marcosramirez_x' },
  'https://images.unsplash.com/photo-1588689115724-a624efec3c93': { name: 'Batu Gezer', username: 'gezerbatu' },
  'https://images.unsplash.com/photo-1557848979-f13d18a41bb2': { name: 'Mr BIMSKY', username: 'mrbimsky' },
  'https://images.unsplash.com/photo-1789110520665-f07353f0afbe': { name: 'engin akyurt', username: 'enginakyurt' },
  'https://images.unsplash.com/photo-1558906050-d6d6aa390fd3': { name: 'Susan Holt Simpson', username: 'shs521' },
  'https://images.unsplash.com/photo-1741521641060-ac14877a6472': { name: 'Zoshua Colah', username: 'zoshuacolah' },
  'https://images.unsplash.com/photo-1722405375190-8d0b2a765840': { name: 'Jakub Żerdzicki', username: 'jakubzerdzicki' },
  'https://images.unsplash.com/photo-1745892477174-61d2145109ed': { name: 'Archer Allstars', username: 'archerallstars' },
  'https://images.unsplash.com/photo-1633354557397-33ee5af54117': { name: 'quokkabottles', username: 'quokkabottle' },
  'https://images.unsplash.com/photo-1646023829533-3bc483fe3531': { name: 'Markus Winkler', username: 'markuswinkler' },
  'https://images.unsplash.com/photo-1434494817513-cc112a976e36': { name: 'Luke Chesser', username: 'lukechesser' },
  'https://images.unsplash.com/photo-1495654794940-1c0cd2aeedc1': { name: 'Kelly Sikkema', username: 'kellysikkema' },
  'https://images.unsplash.com/photo-1636412191749-53d84f5f3eb0': { name: 'Brandon Cormier', username: 'brandoncormier' },
  'https://images.unsplash.com/photo-1581497396202-5645e76a3a8e': { name: 'Giulia Bertelli', username: 'giulia_bertelli' },
  'https://images.unsplash.com/photo-1645199431596-b7da6a10a01b': { name: 'Alison Pang', username: 'alisonpang' },
  'https://images.unsplash.com/photo-1523380262778-076eb862d38f': { name: 'Beth Stevenson', username: 'bthstvn' },
  'https://images.unsplash.com/photo-1532285023254-17336184c0e5': { name: 'Nikolay', username: 'beautyoftech' },
  'https://images.unsplash.com/photo-1535016120720-40c646be5580': { name: 'Alex Litvin', username: 'alexlitvin' },
  'https://images.unsplash.com/photo-1582735689369-4fe89db7114c': { name: 'Annie Spratt', username: 'anniespratt' },
  'https://images.unsplash.com/photo-1624222247344-550fb60583dc': { name: 'L S', username: 'ls8' },
  'https://images.unsplash.com/photo-1788478963160-1c38139e2932': { name: 'Lachlan Rennie', username: 'rennielachlan' },
  'https://images.unsplash.com/photo-1499013819532-e4ff41b00669': { name: 'Alexandra Gorn', username: 'alexagorn' },
  'https://images.unsplash.com/photo-1499033300314-43c811cff6d5': { name: 'Adam Birkett', username: 'abrkett' },
  'https://images.unsplash.com/photo-1612548403247-aa2873e9422d': { name: 'Sirisvisual', username: 'sirisvisual' },
  'https://images.unsplash.com/photo-1591357037205-166318b51afd': { name: 'Oriol Hausmann', username: 'hauxmann' },
  'https://images.unsplash.com/photo-1586201375761-83865001e31c': { name: 'Pierre Bamin', username: 'bamin' },
  'https://images.unsplash.com/photo-1673999707565-8bb553c9765b': { name: 'Haley Hydorn', username: 'h_hydorn' },
  'https://images.unsplash.com/photo-1708063784456-9b9d60058c97': { name: 'Michael Lock', username: 'milo_photo' },
  'https://images.unsplash.com/photo-1573066380308-24ff4c273dbc': { name: 'Ashkan Forouzani', username: 'ashkfor121' },
  'https://images.unsplash.com/photo-1740423099949-b0dfcabd91ce': { name: 'Soulride Photography', username: 'soulride_photography' },
  'https://images.unsplash.com/photo-1519411792752-25c2468cccb3': { name: 'Katrin Leinfellner', username: 'k_ti' },
  'https://images.unsplash.com/photo-1601445638532-3c6f6c3aa1d6': { name: 'Girl with red hat', username: 'girlwithredhat' },
  'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2': { name: 'Jude Infantini', username: 'judowoodo_' },
  'https://images.unsplash.com/photo-1444097315577-49429a8b6224': { name: 'Francis Duval', username: 'francisduval' },
  'https://images.unsplash.com/photo-1606904825846-647eb07f5be2': { name: 'Compare Fibre', username: 'comparefibre' },
  'https://images.unsplash.com/photo-1523471826770-c437b4636fe6': { name: 'Denny Müller', username: 'redaquamedia' },
  'https://images.unsplash.com/photo-1608384156808-418b5c079968': { name: 'Vlad Zaytsev', username: 'vladizlo' },
  'https://images.unsplash.com/photo-1768490428147-f1b3672ffcd6': { name: 'Jimmy Liu', username: 'jimmy__liu' },
  'https://images.unsplash.com/photo-1527977966376-1c8408f9f108': { name: 'Jonathan Lampel', username: 'jonlampel' },
  'https://images.unsplash.com/photo-1612817159623-0399784fd0ce': { name: 'Paul Cuoco', username: 'notafraid' },
  'https://images.unsplash.com/photo-1516724562728-afc824a36e84': { name: 'Robert Shunev', username: 'rshunev' },
  'https://images.unsplash.com/photo-1626697556426-8a55a8af4999': { name: 'Towfiqu barbhuiya', username: 'towfiqu999999' },
  'https://images.unsplash.com/photo-1655029164758-51e484f5576b': { name: 'Alberto Bianchini', username: 'theblanko' },
  'https://images.unsplash.com/photo-1587377224626-36041d9bd9c9': { name: 'Cooker King', username: 'cookerking' },
  'https://images.unsplash.com/photo-1593941707874-ef25b8b4a92b': { name: 'CHUTTERSNAP', username: 'chuttersnap' },
  'https://images.unsplash.com/photo-1611864583067-b002fdc4fa29': { name: 'Miguel Angel  Avila', username: 'miketopus' },
  'https://images.unsplash.com/photo-1621494547944-5ddbc84514b2': { name: 'Duane Mendes', username: 'duanemendes' },
  'https://images.unsplash.com/photo-1568378711447-f5eef04d85b5': { name: 'Mika Baumeister', username: 'kommumikation' },
  'https://images.unsplash.com/photo-1512428559087-560fa5ceab42': { name: 'NordWood Themes', username: 'nordwood' },
  'https://images.unsplash.com/photo-1485712207830-8a665e701494': { name: 'Daria Nepriakhina 🇺🇦', username: 'epicantus' },
  'https://images.unsplash.com/photo-1424798985931-3325521d26e6': { name: 'Jordan McQueen', username: 'jordanfmcqueen' },
  'https://images.unsplash.com/photo-1621886943381-cb97cc18b17a': { name: 'Mary Oakey', username: 'wanderwithoak' },
  'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf': { name: 'Nimble Made', username: 'nimblemade' },
  'https://images.unsplash.com/photo-1686820740687-426a7b9b2043': { name: 'Kseniya Nekrasova', username: 'misiks' },
  'https://images.unsplash.com/photo-1564988208558-9270de7c5848': { name: 'Corleto Peanut butter', username: 'corleto' },
  'https://images.unsplash.com/photo-1623303179820-de8ec58b03dc': { name: 'Carmen Alarcón', username: 'carmen_alarcon' },
  'https://images.unsplash.com/photo-1777613084487-5c741e58ac9a': { name: 'Grace Anne Bobadilla', username: 'graceannefully' },
  'https://images.unsplash.com/photo-1559719740-f4d59cf117cb': { name: 'rishi', username: 'beingabstrac' },
  'https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb': { name: 'Pixzolo Photography', username: 'pixzolo' },
  'https://images.unsplash.com/photo-1536304447766-da0ed4ce1b73': { name: 'Pille R. Priske', username: 'pillepriske' },
  'https://images.unsplash.com/photo-1658036679812-b71a87935630': { name: 'Shawn Rain', username: 'shawn_rain' },
  'https://images.unsplash.com/photo-1703081167394-bb6d575248d0': { name: 'Rohan Krishnan', username: 'rohankrishnann' },
  'https://images.unsplash.com/photo-1696355607944-650405f2aa2e': { name: 'Georgia de Lotz', username: 'georgiadelotz' },
  'https://images.unsplash.com/photo-1766387930184-5d9b2cf6d7a5': { name: 'Bernd 📷 Dittrich', username: 'hdbernd' },
  'https://images.unsplash.com/photo-1789110853398-539d78dd63bc': { name: 'engin akyurt', username: 'enginakyurt' },
  'https://images.unsplash.com/flagged/photo-1572609239482-d3a83f976aa0': { name: 'Chauhan Moniz', username: 'moniz437' },
  'https://images.unsplash.com/photo-1559312379-847994be815b': { name: 'Isaac Smith', username: 'isaacmsmith' },
  'https://images.unsplash.com/photo-1707945272540-35fda815ebbf': { name: 'Ezekiel See', username: 'ezekiel_see' },
  'https://images.unsplash.com/photo-1566441699339-0c7bac167c58': { name: 'insung yoon', username: 'insungpandora' },
  'https://images.unsplash.com/photo-1589995186011-a7b485edc4bf': { name: 'Denny Müller', username: 'redaquamedia' },
  'https://images.unsplash.com/photo-1673196649671-eb09066ad6c1': { name: 'Maria', username: 'lyumotech' },
  'https://images.unsplash.com/photo-1779896412214-52031d27211a': { name: 'Sandisk', username: 'sandisk' },
  'https://images.unsplash.com/photo-1566554738544-d962991c3fee': { name: 'I\'M ZION', username: 'ziontech' },
  'https://images.unsplash.com/photo-1544233726-9f1d2b27be8b': { name: 'Katherine Chase', username: 'thekatiemchase' },
  'https://images.unsplash.com/photo-1631679893114-7957e44879db': { name: 'Spacejoy', username: 'spacejoy' },
  'https://images.unsplash.com/photo-1706765779494-2705542ebe74': { name: 'CGXL MEDIA', username: 'cgxlmedia' },
  'https://images.unsplash.com/photo-1620799140188-3b2a02fd9a77': { name: 'Mediamodifier', username: 'mediamodifier' },
  'https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2': { name: 'Kelly Sikkema', username: 'kellysikkema' },
  'https://images.unsplash.com/photo-1656955178167-3888ac44843c': { name: 'JJ Shev', username: 'skjev5280' },
  'https://images.unsplash.com/photo-1583511655826-05700d52f4d9': { name: 'Karsten Winegeart', username: '_karsten' },
  'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62': { name: 'Arwin Neil Baichoo', username: 'arwinneil' },
  'https://images.unsplash.com/photo-1763368397625-32c8f75fed44': { name: 'Zoshua Colah', username: 'zoshuacolah' },
  'https://images.unsplash.com/photo-1569641092045-f6ec23879aef': { name: 'J. Brouwer', username: 'brouwjess' },
  'https://images.unsplash.com/photo-1558317374-24793bc9f2fb': { name: 'Kowon vn', username: 'kowon' },
  'https://images.unsplash.com/photo-1497888329096-51c27beff665': { name: 'Brooke Lark', username: 'brookelark' },
  'https://images.unsplash.com/photo-1781863065553-e2dfaf6c01a6': { name: 'Amar Preet Singh', username: 'amarallahabadi' },
  'https://images.unsplash.com/photo-1634406722002-95ab36228647': { name: 'Fer Troulik', username: 'fertroulik' },
  'https://images.unsplash.com/photo-1603596310923-dbb12732f9c7': { name: 'Nathan Dumlao', username: 'nate_dumlao' },
  'https://images.unsplash.com/photo-1633442496335-af4d20202da3': { name: 'Towfiqu barbhuiya', username: 'towfiqu999999' },
  'https://images.unsplash.com/photo-1704775989365-eebfd4659a23': { name: 'GLOBALDSIO IT SOLUTION', username: 'globaldsioitsolution' },
  'https://images.unsplash.com/photo-1476900164809-ff19b8ae5968': { name: 'Mike Labrum', username: 'labrum777' },
  'https://images.unsplash.com/photo-1528751014936-863e6e7a319c': { name: 'Emiliano Vittoriosi', username: 'emilianovittoriosi' },
  'https://images.unsplash.com/photo-1549590143-d5855148a9d5': { name: 'Mae Mu', username: 'picoftasty' },
  'https://images.unsplash.com/photo-1599603780100-9a9e42b0489f': { name: 'Andrea Davis', username: 'andreaedavis' },
  'https://images.unsplash.com/photo-1782861563879-2583c154201d': { name: 'Crystal Stone', username: 'sparkle23' },
  'https://images.unsplash.com/photo-1677478863154-55ecce8c7536': { name: 'Bree Anne', username: 'breebuddy' },
  'https://images.unsplash.com/photo-1603217192634-61068e4d4bf9': { name: 'Laura Chouette', username: 'laurachouette' },
  'https://images.unsplash.com/photo-1624378442362-d3247e8126ec': { name: 'Matthew Moloney', username: 'mattmoloney' },
  'https://images.unsplash.com/photo-1576792741377-eb0f4f6d1a47': { name: 'David Lezcano', username: '_thedl' },
  'https://images.unsplash.com/photo-1599182345361-9542815e73f6': { name: 'MChe Lee', username: 'mclee' },
  'https://images.unsplash.com/photo-1493129922668-fcb1a8514643': { name: 'Jose Fontano', username: 'josenothose' },
  'https://images.unsplash.com/photo-1656662418587-ba53f84c94c9': { name: 'Quang Tri NGUYEN', username: 'quangtri' },
  'https://images.unsplash.com/photo-1685342654383-584d56907425': { name: 'Tawseem Hakak', username: 'tawseemhakak' },
  'https://images.unsplash.com/photo-1590845947698-8924d7409b56': { name: 'Daniele Franchi', username: 'daniele_franchi' },
  'https://images.unsplash.com/photo-1628527304201-b5e5bac05615': { name: 'Towfiqu barbhuiya', username: 'towfiqu999999' },
  'https://images.unsplash.com/photo-1529111316-da2e2a1e625d': { name: 'Brian Patrick Tagalog', username: 'briantagalog' },
  'https://images.unsplash.com/photo-1746280978271-1ef1a2d9447f': { name: 'tonny zhong', username: 'baldselect' },
  'https://images.unsplash.com/photo-1522844990619-4951c40f7eda': { name: 'i yunmai', username: 'yunmai' },
  'https://images.unsplash.com/photo-1600188999986-331bec5f9a8d': { name: 'Raspopova Marina', username: 'raspopovamarisha' },
  'https://images.unsplash.com/photo-1613228295977-3b5ac7533b36': { name: 'Monika Grabkowska', username: 'moniqa' },
  'https://images.unsplash.com/photo-1739268984311-b478fccf256e': { name: 'Alin Gavriliuc', username: 'alingavriliuc' },
  'https://images.unsplash.com/photo-1559811814-e2c57b5e69df': { name: 'Victoria Shes', username: 'victoriakosmo' },
  'https://images.unsplash.com/photo-1556761223-4c4282c73f77': { name: 'Mae Mu', username: 'picoftasty' },
  'https://images.unsplash.com/photo-1709534486708-fb8f94150d0a': { name: 'Jakub Żerdzicki', username: 'jakubzerdzicki' },
  'https://images.unsplash.com/photo-1585060544812-6b45742d762f': { name: 'Vojtech Bruzek', username: 'vojtechbruzek' },
  'https://images.unsplash.com/photo-1523362628745-0c100150b504': { name: 'Steve A Johnson', username: 'steve_j' },
  'https://images.unsplash.com/flagged/photo-1558127537-56802139873a': { name: 'INVICTUS Tailoring﹒sneaker socks', username: 'invictustailoring' },
  'https://images.unsplash.com/photo-1602173574767-37ac01994b2a': { name: 'Nataliya Melnychuk', username: 'natinati' },
  'https://images.unsplash.com/photo-1595440430883-f42cc1daac55': { name: 'Cooker King', username: 'cookerking' },
  'https://images.unsplash.com/photo-1577495917765-9497a0de7caa': { name: 'Rumman Amin', username: 'rumanamin' },
  'https://images.unsplash.com/photo-1489274495757-95c7c837b101': { name: 'Filip Mroz', username: 'mroz' },
  'https://images.unsplash.com/photo-1758273238564-806f750a2cce': { name: 'Vitaly Gariev', username: 'silverkblack' },
  'https://images.unsplash.com/photo-1604176354204-9268737828e4': { name: 'Maude Frédérique Lavoie', username: 'maudefl' },
  'https://images.unsplash.com/photo-1468577760773-139c2f1c335f': { name: 'Jonathan Pielmayer', username: 'jonathanpielmayer' },
  'https://images.unsplash.com/photo-1526775310031-fc50d81ce518': { name: 'Panos Sakalakis', username: 'meymigrou' },
  'https://images.unsplash.com/photo-1502404768591-f24d06b7a366': { name: 'Dose Media', username: 'dose' },
  'https://images.unsplash.com/photo-1762237258049-f5936f02335e': { name: 'Royce Fonseca', username: 'casunshine0508' },
  'https://images.unsplash.com/photo-1563139205-b6d0e303ad58': { name: 'Dani', username: 'frokz' },
  'https://images.unsplash.com/photo-1623126908029-58cb08a2b272': { name: 's w', username: 'serwin365' },
  'https://images.unsplash.com/photo-1587033411391-5d9e51cce126': { name: 'Rahul Chakraborty', username: 'hckmstrrahul' },
  'https://images.unsplash.com/photo-1757844743623-b9dd9c2c03a5': { name: 'Zoshua Colah', username: 'zoshuacolah' },
  'https://images.unsplash.com/photo-1472476443507-c7a5948772fc': { name: 'Dennis Klein', username: 'klein3' },
  'https://images.unsplash.com/photo-1548863227-3af567fc3b27': { name: 'Rahul Bhogal', username: 'rahulbhogal' },
  'https://images.unsplash.com/photo-1760465809553-ddcbe4bb4753': { name: 'Nikita Pishchugin', username: 'nikita_pishchugin' },
  'https://images.unsplash.com/photo-1554139844-af2fc8ad3a3a': { name: 'Florian Kurrasch', username: 'flnkrs' },
  'https://images.unsplash.com/photo-1578319439584-104c94d37305': { name: 'Roger Cai', username: 'hi_roger' },
  'https://images.unsplash.com/photo-1784677217180-5957876afedd': { name: 'Alfonso Scarpa', username: 'lucidistortephoto' },
  'https://images.unsplash.com/photo-1758739956768-169833459935': { name: 'Thomas De Giorgio', username: 'ilnevischio' },
  'https://images.unsplash.com/photo-1476136236990-838240be4859': { name: 'Claus Grünstäudl', username: 'w18' },
  'https://images.unsplash.com/photo-1477949331575-2763034b5fb5': { name: 'Brina Blum', username: 'brina_blum' },
  'https://images.unsplash.com/photo-1607125516845-fa8a14db083a': { name: 'Jess Bailey', username: 'jessbaileydesigns' },
  'https://images.unsplash.com/photo-1774915506921-905602b5bd08': { name: 'Gavin Phillips', username: 'gavinspavin' },
  'https://images.unsplash.com/photo-1773125929765-99d4d67e831d': { name: 'Tim Mossholder', username: 'timmossholder' },
  'https://images.unsplash.com/photo-1623251609314-97cc1f84e3ed': { name: 'Riekus', username: 'riekus' },
  'https://images.unsplash.com/photo-1601436423474-51738541c1b1': { name: 'Sandi Benedicta', username: 'sendun' },
  'https://images.unsplash.com/photo-1576633587382-13ddf37b1fc1': { name: 'Jessica Lewis 🦋 thepaintedsquare', username: 'thepaintedsquarejessica' },
  'https://images.unsplash.com/photo-1784916988722-25e996e23aa4': { name: 'Julia Taubitz', username: 'justmejuliee' },
  'https://images.unsplash.com/photo-1563861826100-9cb868fdbe1c': { name: 'Ocean Ng', username: 'oceanng' },
  'https://images.unsplash.com/photo-1524805444758-089113d48a6d': { name: 'Pat Taylor', username: 'ptaylor_' },
  'https://images.unsplash.com/photo-1521223890158-f9f7c3d5d504': { name: 'Adrian Ordonez', username: 'adrianordonez' },
  'https://images.unsplash.com/photo-1674475760738-8c7af859f821': { name: 'Bearaby', username: 'mybearaby' },
  'https://images.unsplash.com/photo-1626379616459-b2ce1d9decbc': { name: 'Maria Fernanda Pissioli', username: 'mxpissioli' },
  'https://images.unsplash.com/photo-1777483997189-9d934b0f177d': { name: 'Bambang Nugroho', username: 'abank88' },
  'https://images.unsplash.com/photo-1597393353365-9d4366392fe9': { name: 'Divani', username: 'heydivani' },
  'https://images.unsplash.com/photo-1516044734145-07ca8eef8731': { name: 'Misha Feshchak', username: 'extaf_ms' },
  'https://images.unsplash.com/photo-1785175861969-b4518b2eaaa6': { name: 'Kedibone Isaac Makhumisane', username: 'isaax_the_artist' },
  'https://images.unsplash.com/photo-1610218588433-227ebd3e8fea': { name: 'Mathilde Langevin', username: 'mathildelangevin' },
  'https://images.unsplash.com/photo-1484704849700-f032a568e944': { name: 'Lee  Campbell', username: 'leecampbell' },
  'https://images.unsplash.com/photo-1674385404267-897dafdc6d42': { name: 'Yusuf Gündüz', username: 'yusufgunduz00' },
  'https://images.unsplash.com/photo-1545235616-db3cd822ad8c': { name: 'Daniel Korpai', username: 'danielkorpai' },
  'https://images.unsplash.com/photo-1614415852388-2406572efce6': { name: 'Claudio Schwarz', username: 'purzlbaum' },
  'https://images.unsplash.com/photo-1781032392300-ed3bdf78ef4c': { name: 'Josh Davies', username: 'mestra' },
  'https://images.unsplash.com/photo-1576871337632-b9aef4c17ab9': { name: 'Fábio  Alves', username: 'barncreative' },
  'https://images.unsplash.com/photo-1619603364904-c0498317e145': { name: 'Taras Chernus', username: 'chernus_tr' },
  'https://images.unsplash.com/photo-1561634109-465ffe688b50': { name: 'Oliur', username: 'ultralinx' },
  'https://images.unsplash.com/photo-1628970976696-19370989142b': { name: 'April Laugh', username: 'aprillaugh' },
  'https://images.unsplash.com/photo-1768983953826-231e8ef0b6dc': { name: 'Kyle Kioko', username: 'kylekioko' },
  'https://images.unsplash.com/photo-1632488507420-64f41ca8dd59': { name: 'Mahdi Gharib', username: 'mahdiverse' },
};

/** Credit for a raw (un-resized) Unsplash image URL, or null if unknown. */
function creditFor(url) {
  if (!url) return null;
  return PHOTO_CREDITS[url.split('?')[0]] ?? null;
}

/** Adds Unsplash's required utm_source/utm_medium to a link to unsplash.com. */
function unsplashLink(path) {
  const url = new URL(path, 'https://unsplash.com');
  url.searchParams.set('utm_source', 'devhut_stores');
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}

/** "Photo by [name] on Unsplash", both names linking out, per Unsplash's API guidelines. */
function creditEl(credit, { compact = false } = {}) {
  if (!credit?.name) return null;
  return h('p', { class: `photo-credit${compact ? ' photo-credit-compact' : ''}` },
    'Photo by ',
    h('a', { href: unsplashLink(`/@${credit.username}`), target: '_blank', rel: 'noopener noreferrer' }, credit.name),
    ' on ',
    h('a', { href: unsplashLink('/'), target: '_blank', rel: 'noopener noreferrer' }, 'Unsplash'));
}

function sizedImage(url, { w = 600, h: height = w, zoom, fpx = 0.5, fpy = 0.5 } = {}) {
  if (!isUnsplash(url)) return url;
  const params = new URLSearchParams({ auto: 'format', fit: 'crop', w, h: height, q: '75' });
  if (zoom) {
    params.set('crop', 'focalpoint');
    params.set('fp-x', fpx);
    params.set('fp-y', fpy);
    params.set('fp-z', zoom);
  }
  return `${url.split('?')[0]}?${params}`;
}

const mainImage = (product, opts) => (product.images[0] ? sizedImage(product.images[0], opts) : placeholderImage(product));

/** Offline-safe SVG placeholder used if a remote image fails to load. */
function placeholderImage(product) {
  const emoji = CATEGORY_MAP.get(product.category)?.emoji ?? '🛍️';
  const safeName = product.name.replace(/[<>&"']/g, '').slice(0, 30);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#dcf1e9"/><text x="200" y="185" font-size="120" text-anchor="middle" dominant-baseline="middle">${emoji}</text><text x="200" y="310" font-family="system-ui,sans-serif" font-size="20" fill="#0f7b5f" text-anchor="middle">${safeName}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createImage(product, src, { alt = product.name, eager = false, size = 600 } = {}) {
  const img = h('img', {
    src, alt, class: 'fade',
    width: size, height: size,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
  });
  img.addEventListener('load', () => img.classList.add('is-loaded'));
  img.addEventListener('error', () => {
    if (img.dataset.fallback) return;          // avoid loops
    img.dataset.fallback = '1';
    img.src = placeholderImage(product);
  });
  return img;
}

// A single Unsplash photo gets zoomed "detail" views; uploaded photos are shown as they are
const ZOOM_VIEWS = [
  { label: 'Main view' },
  { label: 'Detail view', zoom: 1.7, fpx: 0.35, fpy: 0.4 },
  { label: 'Close-up', zoom: 2.3, fpx: 0.62, fpy: 0.6 },
];

function buildGallery(product) {
  const { images } = product;
  if (images.length === 0) {
    const src = placeholderImage(product);
    return [{ label: 'Photo', src, thumb: src, credit: null }];
  }
  if (images.length === 1 && isUnsplash(images[0])) {
    const credit = creditFor(images[0]);
    return ZOOM_VIEWS.map((view) => ({
      label: view.label,
      src: sizedImage(images[0], { w: 900, ...view }),
      thumb: sizedImage(images[0], { w: 160, ...view }),
      credit,
    }));
  }
  return images.map((url, i) => ({
    label: `Photo ${i + 1}`,
    src: sizedImage(url, { w: 900 }),
    thumb: sizedImage(url, { w: 160 }),
    credit: creditFor(url),
  }));
}

/* Product helpers --------------------------------------------------------- */
const getProduct = (id) => PRODUCT_MAP.get(id);
const getCategoryLabel = (id) => CATEGORY_MAP.get(id)?.label ?? 'All products';
const maxQtyFor = (product) => Math.min(product.stock, MAX_QTY_PER_LINE);

function discountPercent(product) {
  if (!product.oldPrice || product.oldPrice <= product.price) return 0;
  return Math.round((1 - product.price / product.oldPrice) * 100);
}

/** Ensures options only contain valid variant choices, defaulting to the first. */
function sanitizeOptions(product, options = {}) {
  const clean = {};
  for (const variant of product.variants ?? []) {
    const chosen = options?.[variant.name];
    clean[variant.name] = variant.options.some((o) => o.label === chosen) ? chosen : variant.options[0].label;
  }
  return clean;
}

function unitPrice(product, options = {}) {
  let price = product.price;
  for (const variant of product.variants ?? []) {
    const option = variant.options.find((o) => o.label === options[variant.name]);
    price += option?.delta ?? 0;
  }
  return round2(price);
}

const formatOptions = (options = {}) => Object.entries(options).map(([k, v]) => `${k}: ${v}`).join(', ');
const lineKey = (id, options) => `${id}|${Object.values(options).join('|')}`;

/* -------------------------------------------------------------------------
   4. STATE & STORES
   ------------------------------------------------------------------------- */
const listeners = new Set();
const subscribe = (fn) => listeners.add(fn);
const notify = (type) => listeners.forEach((fn) => fn(type));

const Cart = {
  lines: [],

  load() {
    const raw = readStorage(STORAGE_KEYS.cart, []);
    if (!Array.isArray(raw)) return;
    const merged = new Map();
    for (const item of raw) {
      const product = getProduct(item?.id);
      if (!product || product.stock < 1 || !Number.isInteger(item.qty) || item.qty < 1) continue;
      const options = sanitizeOptions(product, item.options);
      const key = lineKey(product.id, options);
      const existing = merged.get(key);
      const qty = clamp((existing?.qty ?? 0) + item.qty, 1, maxQtyFor(product));
      merged.set(key, { key, id: product.id, options, qty });
    }
    this.lines = [...merged.values()];
  },

  save() {
    writeStorage(STORAGE_KEYS.cart, this.lines.map(({ id, options, qty }) => ({ id, options, qty })));
    notify('cart');
  },

  /** Returns { added, capped } so the UI can tell the shopper what happened. */
  add(id, options = {}, qty = 1) {
    const product = getProduct(id);
    if (!product || product.stock < 1) return { added: 0, capped: false };
    const clean = sanitizeOptions(product, options);
    const key = lineKey(id, clean);
    const max = maxQtyFor(product);
    const line = this.lines.find((l) => l.key === key);
    const before = line?.qty ?? 0;
    const after = clamp(before + qty, 1, max);
    if (line) line.qty = after;
    else this.lines.push({ key, id, options: clean, qty: after });
    this.save();
    return { added: after - before, capped: before + qty > max };
  },

  setQty(key, qty) {
    const line = this.lines.find((l) => l.key === key);
    if (!line) return;
    line.qty = clamp(Math.round(qty), 1, maxQtyFor(getProduct(line.id)));
    this.save();
  },

  remove(key) {
    const index = this.lines.findIndex((l) => l.key === key);
    if (index === -1) return null;
    const [removed] = this.lines.splice(index, 1);
    this.save();
    return { line: removed, index };
  },

  restore({ line, index }) {
    if (this.lines.some((l) => l.key === line.key)) return;
    this.lines.splice(index, 0, line);
    this.save();
  },

  clear() {
    this.lines = [];
    this.save();
  },

  count() {
    return this.lines.reduce((sum, l) => sum + l.qty, 0);
  },

  subtotal() {
    return round2(this.lines.reduce((sum, l) => sum + unitPrice(getProduct(l.id), l.options) * l.qty, 0));
  },
};

const Wishlist = {
  ids: new Set(),

  load() {
    const raw = readStorage(STORAGE_KEYS.wishlist, []);
    this.ids = new Set(Array.isArray(raw) ? raw.filter((id) => PRODUCT_MAP.has(id)) : []);
  },

  has(id) {
    return this.ids.has(id);
  },

  toggle(id) {
    if (!PRODUCT_MAP.has(id)) return false;
    const added = !this.ids.has(id);
    if (added) this.ids.add(id);
    else this.ids.delete(id);
    writeStorage(STORAGE_KEYS.wishlist, [...this.ids]);
    notify('wishlist');
    return added;
  },
};

// Filter and UI state (not persisted)
const filters = { query: '', category: 'all', min: null, max: null, sort: 'featured' };
const ui = {
  loading: true,
  ready: false,
  route: '',
  view: 'home',
  homeScrollY: 0,
  scrollToResults: false,
  openPanel: null,        // 'cart' | 'filters' | null
  lastFocus: null,
};

function getDeliveryTotals(delivery = 'standard') {
  const subtotal = Cart.subtotal();
  let shipping = DELIVERY_OPTIONS[delivery]?.fee ?? DELIVERY_OPTIONS.standard.fee;
  if (delivery === 'standard' && subtotal >= FREE_SHIPPING_THRESHOLD) shipping = 0;
  if (subtotal === 0) shipping = 0;
  return { subtotal, shipping, total: round2(subtotal + shipping) };
}

function getFilteredProducts() {
  const query = filters.query.trim().toLowerCase();
  const terms = query ? query.split(/\s+/) : [];
  const list = PRODUCTS.filter((p) =>
    (filters.category === 'all' || p.category === filters.category) &&
    (filters.min == null || p.price >= filters.min) &&
    (filters.max == null || p.price <= filters.max) &&
    terms.every((t) => p.searchText.includes(t)));

  const sorters = {
    featured: (a, b) => a.featured - b.featured,
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
    discount: (a, b) => discountPercent(b) - discountPercent(a),
  };
  return list.sort(sorters[filters.sort] ?? sorters.featured);
}

/* -------------------------------------------------------------------------
   5. RENDERING: GRID, CARDS, FILTERS
   ------------------------------------------------------------------------- */
const dom = {};

function cacheDom() {
  Object.assign(dom, {
    skipLink: $('#skip-link'),
    main: $('#main'),
    searchForm: $('#search-form'),
    searchInput: $('#search-input'),
    searchClear: $('#search-clear'),
    themeToggle: $('#theme-toggle'),
    currencySelect: $('#currency-select'),
    wishlistLink: $('#wishlist-link'),
    wishlistCount: $('#wishlist-count'),
    cartButton: $('#cart-button'),
    cartCount: $('#cart-count'),
    categoryNav: $('#category-nav-list'),
    heroFeature: $('#hero-feature'),
    heroShop: $('#hero-shop'),
    flashTimer: $('#flash-timer'),
    shop: $('#shop'),
    filters: $('#filters'),
    filtersOpen: $('#filters-open'),
    filtersClose: $('#filters-close'),
    filtersApply: $('#filters-apply'),
    categoryFilter: $('#category-filter-list'),
    priceMin: $('#price-min'),
    priceMax: $('#price-max'),
    priceError: $('#price-error'),
    pricePresets: $('#price-presets'),
    sortSelect: $('#sort-select'),
    resultsCount: $('#results-count'),
    activeFilters: $('#active-filters'),
    grid: $('#product-grid'),
    gridEmpty: $('#grid-empty'),
    gridError: $('#grid-error'),
    gridErrorText: $('#grid-error-text'),
    gridRetry: $('#grid-retry'),
    productDetail: $('#product-detail'),
    wishlistGrid: $('#wishlist-grid'),
    wishlistEmpty: $('#wishlist-empty'),
    wishlistSubtitle: $('#wishlist-subtitle'),
    checkoutContent: $('#checkout-content'),
    checkoutEmpty: $('#checkout-empty'),
    checkoutForm: $('#checkout-form'),
    cardFields: $('#card-fields'),
    placeOrder: $('#place-order'),
    standardFee: $('#standard-fee'),
    expressFee: $('#express-fee'),
    summaryItems: $('#summary-items'),
    summarySubtotal: $('#summary-subtotal'),
    summaryShipping: $('#summary-shipping'),
    summaryTotal: $('#summary-total'),
    confirmation: $('#confirmation'),
    overlay: $('#overlay'),
    cartDrawer: $('#cart-drawer'),
    cartTitle: $('#cart-title'),
    cartTitleCount: $('#cart-title-count'),
    cartClose: $('#cart-close'),
    cartItems: $('#cart-items'),
    cartEmpty: $('#cart-empty'),
    cartFoot: $('#cart-foot'),
    cartSubtotal: $('#cart-subtotal'),
    shippingHint: $('#shipping-hint'),
    shippingProgress: $('#shipping-progress'),
    checkoutLink: $('#checkout-link'),
    toastRegion: $('#toast-region'),
    views: $$('.view'),
  });
}

function ratingEl(product) {
  return h('div', { class: 'rating' },
    h('span', {
      class: 'stars', role: 'img', style: `--rating:${product.rating}`,
      'aria-label': `Rated ${product.rating} out of 5 from ${product.reviews.toLocaleString('en-US')} reviews`,
    }, '★★★★★'),
    h('span', { 'aria-hidden': 'true' }, `${product.rating.toFixed(1)} (${product.reviews.toLocaleString('en-US')})`));
}

function priceEl(product, price = product.price) {
  const wrap = h('p', { class: 'price' }, h('span', { class: 'price-now' }, formatPrice(price)));
  if (discountPercent(product)) {
    const oldPrice = product.oldPrice + (price - product.price);
    wrap.append(h('s', { class: 'price-old' }, h('span', { class: 'visually-hidden' }, 'Was '), formatPrice(oldPrice)));
  }
  return wrap;
}

function updateWishButton(btn) {
  const product = getProduct(btn.dataset.wishId);
  if (!product) return;
  const saved = Wishlist.has(product.id);
  btn.setAttribute('aria-pressed', String(saved));
  btn.classList.toggle('is-active', saved);
  const label = btn.querySelector('.wish-label');
  if (label) label.textContent = saved ? 'Saved to wishlist' : 'Save to wishlist';
}

function wishButton(product, { withText = false } = {}) {
  const btn = h('button', {
    type: 'button',
    class: withText ? 'btn btn-outline wish-toggle' : 'wish-btn',
    'data-wish-id': product.id,
    'aria-label': withText ? null : `Save ${product.name} to wishlist`,
  }, icon('heart'), withText ? h('span', { class: 'wish-label' }) : null);
  updateWishButton(btn);
  return btn;
}

function createProductCard(product) {
  const url = `#/product/${product.id}`;
  const discount = discountPercent(product);
  const hasVariants = (product.variants ?? []).length > 0;

  const cta = product.stock < 1
    ? h('button', { type: 'button', class: 'btn btn-outline btn-sm card-cta', disabled: true }, 'Out of stock')
    : hasVariants
    ? h('a', { href: url, class: 'btn btn-outline btn-sm card-cta', 'aria-label': `Choose options for ${product.name}` }, 'Choose options')
    : h('button', { type: 'button', class: 'btn btn-primary btn-sm card-cta', 'data-add-id': product.id, 'aria-label': `Add ${product.name} to cart` }, icon('cart'), h('span', {}, 'Add to cart'));

  return h('li', { class: 'product-card' },
    h('article', { class: 'card' },
      // Image link is hidden from assistive tech: the title link below is the accessible one
      h('a', { href: url, class: 'card-media', tabindex: '-1', 'aria-hidden': 'true' },
        createImage(product, mainImage(product, { w: 480 }), { alt: '' }),
        discount ? h('span', { class: 'tag tag-discount' }, `-${discount}%`) : null,
        product.isNew ? h('span', { class: 'tag tag-new' }, 'New') : null),
      wishButton(product),
      h('div', { class: 'card-body' },
        h('p', { class: 'card-category' }, getCategoryLabel(product.category)),
        h('h3', { class: 'card-title' }, h('a', { href: url }, h('span', { class: 'card-title-text' }, product.name))),
        ratingEl(product),
        priceEl(product),
        product.stock > 0 && product.stock <= 5 ? h('p', { class: 'stock-low' }, `Only ${product.stock} left`) : null,
        cta)));
}

// Cards are built once and reused across filter changes (no needless re-creation)
const cardCache = new Map();
function getCachedCard(product) {
  if (!cardCache.has(product.id)) cardCache.set(product.id, createProductCard(product));
  return cardCache.get(product.id);
}

function renderSkeletons(count = 8) {
  dom.grid.setAttribute('aria-busy', 'true');
  dom.grid.replaceChildren(...Array.from({ length: count }, () =>
    h('li', { class: 'product-card', 'aria-hidden': 'true' },
      h('div', { class: 'card' },
        h('div', { class: 'skeleton skeleton-media' }),
        h('div', { class: 'card-body' },
          h('div', { class: 'skeleton skeleton-line w-40' }),
          h('div', { class: 'skeleton skeleton-line w-90' }),
          h('div', { class: 'skeleton skeleton-line w-60' }),
          h('div', { class: 'skeleton skeleton-btn' }))))));
}

function renderGrid() {
  if (ui.loading) return;
  const results = getFilteredProducts();
  dom.grid.replaceChildren(...results.map(getCachedCard));
  dom.grid.removeAttribute('aria-busy');
  dom.grid.hidden = results.length === 0;
  dom.gridEmpty.hidden = results.length > 0;
  dom.resultsCount.textContent = results.length === 1 ? '1 product' : `${results.length} products`;
  renderActiveFilters();
}

function renderActiveFilters() {
  const pills = [];
  const pill = (label, onRemove) => h('button', {
    type: 'button', class: 'filter-pill', 'aria-label': `Remove filter: ${label}`, onClick: onRemove,
  }, h('span', {}, label), icon('close'));

  if (filters.query.trim()) {
    pills.push(pill(`“${filters.query.trim()}”`, () => { setSearch(''); }));
  }
  if (filters.category !== 'all') {
    pills.push(pill(getCategoryLabel(filters.category), () => setCategory('all')));
  }
  if (filters.min != null || filters.max != null) {
    const label = filters.min != null && filters.max != null
      ? `${formatPrice(filters.min)} to ${formatPrice(filters.max)}`
      : filters.min != null ? `Over ${formatPrice(filters.min)}` : `Under ${formatPrice(filters.max)}`;
    pills.push(pill(label, () => setPrice(null, null)));
  }
  dom.activeFilters.replaceChildren(...pills);
}

function renderCategoryControls() {
  const all = [{ id: 'all', label: 'All', emoji: '🛍️' }, ...CATEGORIES];

  dom.categoryNav.replaceChildren(...all.map((c) =>
    h('li', {}, h('button', { type: 'button', class: 'chip', 'data-category': c.id, 'aria-pressed': 'false' },
      h('span', { class: 'chip-emoji', 'aria-hidden': 'true' }, c.emoji), c.label))));

  dom.categoryFilter.replaceChildren(...all.map((c) => {
    const count = c.id === 'all' ? PRODUCTS.length : PRODUCTS.filter((p) => p.category === c.id).length;
    const input = h('input', { type: 'radio', name: 'category', value: c.id });
    input.addEventListener('change', () => setCategory(c.id, { fromSidebar: true }));
    return h('label', { class: 'radio-row' }, input, h('span', {}, c.id === 'all' ? 'All categories' : c.label),
      h('span', { class: 'radio-count' }, String(count)));
  }));

  dom.pricePresets.replaceChildren(...PRICE_PRESETS.map((preset, i) =>
    h('button', {
      type: 'button', class: 'chip', 'aria-pressed': 'false', dataset: { preset: String(i) },
      onClick: () => setPrice(preset.min, preset.max),
    }, presetLabel(preset))));

  syncFilterControls();
}

/** Keeps every filter control in sync with the filter state. */
function syncFilterControls() {
  $$('[data-category]', dom.categoryNav).forEach((btn) =>
    btn.setAttribute('aria-pressed', String(btn.dataset.category === filters.category)));
  $$('input[name="category"]', dom.categoryFilter).forEach((input) => { input.checked = input.value === filters.category; });
  $$('[data-preset]', dom.pricePresets).forEach((btn) => {
    const p = PRICE_PRESETS[Number(btn.dataset.preset)];
    btn.setAttribute('aria-pressed', String(p.min === filters.min && p.max === filters.max));
  });
  if (document.activeElement !== dom.priceMin) dom.priceMin.value = filters.min ?? '';
  if (document.activeElement !== dom.priceMax) dom.priceMax.value = filters.max ?? '';
  dom.sortSelect.value = filters.sort;
  if (document.activeElement !== dom.searchInput) dom.searchInput.value = filters.query;
  dom.searchClear.hidden = !dom.searchInput.value;
}

/* Filter actions ---------------------------------------------------------- */
function applyFilterChange() {
  syncFilterControls();
  if (ui.view !== 'home') {
    ui.scrollToResults = true;
    location.hash = '#/';
  } else {
    renderGrid();
  }
}

function setCategory(id, { fromSidebar = false } = {}) {
  filters.category = CATEGORY_MAP.has(id) ? id : 'all';
  applyFilterChange();
  if (!fromSidebar && ui.view === 'home') scrollToResultsIfNeeded();
}

function setPrice(min, max) {
  filters.min = min;
  filters.max = max;
  dom.priceError.textContent = '';
  dom.priceMin.removeAttribute('aria-invalid');
  dom.priceMax.removeAttribute('aria-invalid');
  dom.priceMin.value = min ?? '';
  dom.priceMax.value = max ?? '';
  applyFilterChange();
}

function setSearch(value) {
  filters.query = value.slice(0, 80);
  dom.searchInput.value = filters.query;
  dom.searchClear.hidden = !filters.query;
  applyFilterChange();
}

function resetFilters() {
  Object.assign(filters, { query: '', category: 'all', min: null, max: null, sort: 'featured' });
  dom.priceError.textContent = '';
  dom.searchInput.value = '';
  setPrice(null, null);
}

/** Reads the min/max inputs, validates them and applies the filter. */
function readPriceInputs() {
  const parse = (input) => {
    const raw = input.value.trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  const min = parse(dom.priceMin);
  const max = parse(dom.priceMax);
  let error = '';
  if (Number.isNaN(min) || Number.isNaN(max)) error = 'Enter a price of 0 or more.';
  else if (min != null && max != null && min > max) error = 'Min price must be lower than max price.';

  dom.priceError.textContent = error;
  dom.priceMin.setAttribute('aria-invalid', String(Boolean(error) && (Number.isNaN(min) || min > max)));
  dom.priceMax.setAttribute('aria-invalid', String(Boolean(error) && (Number.isNaN(max) || min > max)));
  if (error) return;

  filters.min = min;
  filters.max = max;
  applyFilterChange();
}

function scrollToResultsIfNeeded() {
  const top = dom.shop.getBoundingClientRect().top;
  if (top < 0 || top > window.innerHeight * 0.6) dom.shop.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Hero: featured deal + flash-sale countdown ------------------------------ */
function renderHeroFeature() {
  const product = [...PRODUCTS].filter((p) => p.stock > 0)
    .sort((a, b) => discountPercent(b) - discountPercent(a) || a.featured - b.featured)[0];
  if (!product) { dom.heroFeature.replaceChildren(); return; }
  const discount = discountPercent(product);
  const url = `#/product/${product.id}`;
  dom.heroFeature.replaceChildren(
    h('div', { class: 'hero-feature-media' },
      createImage(product, mainImage(product, { w: 560, h: 420 }), { alt: product.name, eager: true }),
      discount ? h('span', { class: 'tag tag-discount' }, `-${discount}%`) : null),
    h('div', {},
      h('p', { class: 'hero-feature-kicker' }, 'Deal of the day'),
      h('p', { class: 'hero-feature-name' }, h('a', { href: url }, h('span', { class: 'hero-feature-name-text' }, product.name))),
      priceEl(product)));
}

function startFlashTimer() {
  const units = { h: $('[data-unit="h"]', dom.flashTimer), m: $('[data-unit="m"]', dom.flashTimer), s: $('[data-unit="s"]', dom.flashTimer) };
  const tick = () => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);                    // sale resets at midnight
    const secs = Math.max(0, Math.floor((end - now) / 1000));
    const hh = Math.floor(secs / 3600);
    const mm = Math.floor((secs % 3600) / 60);
    const ss = secs % 60;
    units.h.textContent = String(hh).padStart(2, '0');
    units.m.textContent = String(mm).padStart(2, '0');
    units.s.textContent = String(ss).padStart(2, '0');
    dom.flashTimer.setAttribute('aria-label', `Flash sale ends in ${hh} hours and ${mm} minutes`);
  };
  tick();
  setInterval(tick, 1000);
}

/* -------------------------------------------------------------------------
   6. RENDERING: PRODUCT DETAIL, CART, WISHLIST, CHECKOUT, CONFIRMATION
   ------------------------------------------------------------------------- */
function qtyStepper({ value, min = 1, max, label, onChange, small = false }) {
  const input = h('input', { type: 'number', class: 'qty-input', inputmode: 'numeric', min, max, value, 'aria-label': label });
  const dec = h('button', { type: 'button', class: 'qty-btn', 'aria-label': 'Decrease quantity' }, icon('minus'));
  const inc = h('button', { type: 'button', class: 'qty-btn', 'aria-label': 'Increase quantity' }, icon('plus'));

  function set(next, emit = true) {
    const v = clamp(Math.round(Number(next)) || min, min, max);
    input.value = v;
    dec.disabled = v <= min;
    inc.disabled = v >= max;
    if (emit) onChange(v);
  }
  dec.addEventListener('click', () => set(Number(input.value) - 1));
  inc.addEventListener('click', () => set(Number(input.value) + 1));
  input.addEventListener('change', () => set(input.value));
  set(value, false);

  const el = h('div', { class: `qty${small ? ' qty-sm' : ''}`, role: 'group', 'aria-label': label }, dec, input, inc);
  return { el, setValue: (v) => set(v, false) };
}

function renderProductDetail(id) {
  const product = getProduct(id);
  if (!product) return false;

  const selection = sanitizeOptions(product, {});
  const max = maxQtyFor(product);
  const soldOut = max < 1;
  let quantity = 1;

  /* Gallery */
  const gallery = buildGallery(product);
  let active = 0;
  const mainImg = createImage(product, gallery[0].src, { alt: `${product.name}, ${gallery[0].label}`, eager: true, size: 900 });
  const counter = h('span', { class: 'gallery-counter', 'aria-hidden': 'true' });
  const thumbButtons = gallery.map((img, i) =>
    h('button', {
      type: 'button', class: 'gallery-thumb',
      'aria-label': `Show image ${i + 1} of ${gallery.length}: ${img.label}`,
      onClick: () => showImage(i),
    }, createImage(product, img.thumb, { alt: '', size: 160 })));

  // Photo credit: a small toggle over the photo opens a panel with the Unsplash
  // attribution, instead of always showing it. Hidden entirely when the current
  // photo has no known credit (an uploaded photo, or one not yet matched).
  const creditPanelId = `gallery-credit-${product.id}`;
  const creditPanel = h('div', { class: 'gallery-credit-panel', id: creditPanelId, hidden: true });
  const creditToggle = h('button', {
    type: 'button', class: 'gallery-credit-toggle', 'aria-label': 'Photo credit',
    'aria-expanded': 'false', 'aria-controls': creditPanelId, hidden: true,
  }, 'ⓘ');
  creditToggle.addEventListener('click', () => {
    const opening = creditPanel.hidden;
    creditPanel.hidden = !opening;
    creditToggle.setAttribute('aria-expanded', String(opening));
  });

  function closeCreditPanel() {
    creditPanel.hidden = true;
    creditToggle.setAttribute('aria-expanded', 'false');
  }

  function updateCredit() {
    const credit = gallery[active].credit;
    closeCreditPanel();
    creditToggle.hidden = !credit?.name;
    if (credit?.name) creditPanel.replaceChildren(creditEl(credit));
    else creditPanel.replaceChildren();
  }

  function showImage(index) {
    active = (index + gallery.length) % gallery.length;
    delete mainImg.dataset.fallback;
    mainImg.classList.remove('is-loaded');
    mainImg.src = gallery[active].src;
    mainImg.alt = `${product.name}, ${gallery[active].label}`;
    counter.textContent = `${active + 1} / ${gallery.length}`;
    thumbButtons.forEach((btn, i) => btn.setAttribute('aria-current', String(i === active)));
    updateCredit();
  }

  const galleryEl = h('div', { class: 'gallery' },
    h('div', { class: 'gallery-main' }, mainImg, creditToggle, creditPanel,
      gallery.length > 1 ? [
        h('button', { type: 'button', class: 'gallery-nav prev', 'aria-label': 'Previous image', onClick: () => showImage(active - 1) }, icon('chevron-left')),
        h('button', { type: 'button', class: 'gallery-nav next', 'aria-label': 'Next image', onClick: () => showImage(active + 1) }, icon('chevron-right')),
        counter] : null),
    gallery.length > 1
      ? h('ul', { class: 'gallery-thumbs', 'aria-label': 'Product images' }, thumbButtons.map((btn) => h('li', {}, btn)))
      : null);

  // Arrow keys switch images, Escape closes the credit panel, while focus is inside the gallery
  galleryEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { showImage(active - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { showImage(active + 1); e.preventDefault(); }
    if (e.key === 'Escape' && !creditPanel.hidden) { closeCreditPanel(); e.preventDefault(); }
  });
  showImage(0);

  /* Price (updates with variant choice) */
  const priceWrap = h('div', { class: 'pdp-price' });
  const updatePrice = () => {
    const discount = discountPercent(product);
    priceWrap.replaceChildren(priceEl(product, unitPrice(product, selection)),
      discount ? h('span', { class: 'tag tag-discount' }, `Save ${discount}%`) : null);
  };
  updatePrice();

  /* Variants */
  const variantGroups = (product.variants ?? []).map((variant, vi) => {
    const selectedText = h('span', { class: 'variant-selected' }, selection[variant.name]);
    return h('fieldset', { class: 'variant-group' },
      h('legend', {}, `${variant.name}: `, selectedText),
      h('div', { class: 'variant-options' }, variant.options.map((opt, oi) => {
        const inputId = `v-${product.id}-${vi}-${oi}`;
        const input = h('input', {
          type: 'radio', class: 'visually-hidden variant-input', id: inputId,
          name: `variant-${vi}`, value: opt.label, checked: opt.label === selection[variant.name],
        });
        input.addEventListener('change', () => {
          selection[variant.name] = opt.label;
          selectedText.textContent = opt.label;
          updatePrice();
        });
        return h('div', {}, input, h('label', { for: inputId, class: 'variant-pill' }, opt.label,
          opt.delta ? h('span', { class: 'variant-delta' }, `+${formatPrice(opt.delta)}`) : null));
      })));
  });

  /* Quantity + buy */
  const stepper = qtyStepper({ value: 1, max: Math.max(1, max), label: `Quantity of ${product.name}`, onChange: (v) => { quantity = v; } });
  const addBtn = soldOut
    ? h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: true }, 'Out of stock')
    : h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, icon('cart'), h('span', {}, 'Add to cart'));
  addBtn.addEventListener('click', () => {
    const { added, capped } = Cart.add(product.id, selection, quantity);
    const opts = formatOptions(selection);
    if (added === 0) {
      toast(`You already have the maximum of ${max} in your cart.`, { type: 'error' });
      return;
    }
    toast(`Added ${added} × ${product.name}${opts ? ` (${opts})` : ''} to cart${capped ? `. Limit is ${max} per order.` : ''}`, {
      action: { label: 'View cart', onClick: openCart },
    });
    flashButton(addBtn, 'Added');
    stepper.setValue(1);
    quantity = 1;
  });

  const stockNote = h('p', { class: `stock-note${product.stock <= 5 ? ' low' : ''}` },
    soldOut ? 'Out of stock' : product.stock <= 5 ? `Only ${product.stock} left in stock` : 'In stock, ready to ship');

  const category = CATEGORY_MAP.get(product.category) ?? { id: 'all', label: 'All products' };
  const related = PRODUCTS.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 4);

  dom.productDetail.replaceChildren(
    h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' },
      h('ol', {},
        h('li', {}, h('a', { href: '#/' }, 'Home')),
        h('li', {}, h('a', { href: '#/', dataset: { categoryLink: category.id } }, category.label)),
        h('li', {}, h('span', { 'aria-current': 'page' }, product.name)))),
    h('article', { class: 'pdp' },
      galleryEl,
      h('div', { class: 'pdp-info' },
        h('p', { class: 'pdp-brand' }, product.brand),
        h('h1', { tabindex: '-1', 'data-view-heading': '' }, product.name),
        ratingEl(product),
        priceWrap,
        h('p', { class: 'pdp-desc' }, product.description),
        product.highlights.length ? h('ul', { class: 'pdp-highlights' }, product.highlights.map((item) => h('li', {}, item))) : null,
        variantGroups,
        stockNote,
        h('div', { class: 'pdp-buy' }, soldOut ? null : stepper.el, addBtn),
        wishButton(product, { withText: true }),
        h('ul', { class: 'pdp-assurance' },
          h('li', {}, icon('truck'), h('span', {}, `Free standard delivery on orders over ${formatPrice(FREE_SHIPPING_THRESHOLD)}`)),
          h('li', {}, icon('refresh'), h('span', {}, 'Return within 7 days if it isn’t right')),
          h('li', {}, icon('shield'), h('span', {}, 'Pay on delivery available'))))),
    related.length ? h('section', { class: 'related', 'aria-labelledby': 'related-title' },
      h('h2', { id: 'related-title' }, `More in ${category.label}`),
      h('ul', { class: 'product-grid product-grid-wide' }, related.map(createProductCard))) : null);

  document.title = `${product.name} | Devhut Stores`;
  return true;
}

/** Briefly shows a confirmation state on a button after an action. */
function flashButton(btn, text) {
  if (btn.dataset.flashing) return;
  btn.dataset.flashing = '1';
  const original = [...btn.childNodes];
  btn.replaceChildren(icon('check'), h('span', {}, text));
  setTimeout(() => {
    btn.replaceChildren(...original);
    delete btn.dataset.flashing;
  }, 1200);
}

/* Cart drawer: lines are diffed by key so steppers keep focus while updating */
const cartLineNodes = new Map();

function createCartLine(line) {
  const product = getProduct(line.id);
  const url = `#/product/${product.id}`;
  const optionsText = formatOptions(line.options);
  const unit = unitPrice(product, line.options);
  const totalNode = h('p', { class: 'cart-line-total' });
  const stepper = qtyStepper({
    value: line.qty, max: maxQtyFor(product), small: true,
    label: `Quantity of ${product.name}`,
    onChange: (qty) => Cart.setQty(line.key, qty),
  });

  const li = h('li', { class: 'cart-line' },
    h('a', { href: url, class: 'cart-line-media', tabindex: '-1', 'aria-hidden': 'true' },
      createImage(product, mainImage(product, { w: 160 }), { alt: '', size: 160 })),
    h('div', { class: 'cart-line-info' },
      h('a', { href: url, class: 'cart-line-name' }, product.name),
      optionsText ? h('p', { class: 'cart-line-options' }, optionsText) : null,
      h('p', { class: 'cart-line-unit' }, `${formatPrice(unit)} each`),
      h('div', { class: 'cart-line-actions' },
        stepper.el,
        h('button', {
          type: 'button', class: 'icon-btn icon-btn-sm remove-btn',
          'aria-label': `Remove ${product.name} from cart`,
          onClick: () => removeLineWithUndo(line.key),
        }, icon('trash')))),
    totalNode);

  return {
    li,
    update(current) {
      stepper.setValue(current.qty);
      totalNode.textContent = formatPrice(unit * current.qty);
    },
  };
}

function renderCart() {
  const seen = new Set();
  Cart.lines.forEach((line, index) => {
    seen.add(line.key);
    let entry = cartLineNodes.get(line.key);
    if (!entry) {
      entry = createCartLine(line);
      cartLineNodes.set(line.key, entry);
    }
    entry.update(line);
    if (dom.cartItems.children[index] !== entry.li) {
      dom.cartItems.insertBefore(entry.li, dom.cartItems.children[index] ?? null);
    }
  });
  for (const [key, entry] of cartLineNodes) {
    if (!seen.has(key)) {
      entry.li.remove();
      cartLineNodes.delete(key);
    }
  }

  const count = Cart.count();
  const subtotal = Cart.subtotal();
  dom.cartItems.hidden = count === 0;
  dom.cartEmpty.hidden = count > 0;
  dom.cartFoot.hidden = count === 0;
  dom.cartTitleCount.textContent = count ? `(${count})` : '';
  dom.cartSubtotal.textContent = formatPrice(subtotal);

  const remaining = round2(FREE_SHIPPING_THRESHOLD - subtotal);
  dom.shippingHint.textContent = remaining > 0
    ? `Add ${formatPrice(remaining)} more for free standard delivery.`
    : 'You’ve unlocked free standard delivery.';
  dom.shippingProgress.style.width = `${clamp((subtotal / FREE_SHIPPING_THRESHOLD) * 100, 0, 100)}%`;
}

function removeLineWithUndo(key) {
  const removed = Cart.remove(key);
  if (!removed) return;
  const product = getProduct(removed.line.id);
  if (ui.openPanel === 'cart') dom.cartTitle.focus();     // keep focus inside the drawer
  toast(`Removed ${product.name}`, { action: { label: 'Undo', onClick: () => Cart.restore(removed) } });
}

function updateBadges() {
  const count = Cart.count();
  const bump = dom.cartCount.textContent !== String(count) && count > 0;
  dom.cartCount.textContent = String(count);
  dom.cartCount.hidden = count === 0;
  dom.cartButton.setAttribute('aria-label', `Open cart, ${count} ${count === 1 ? 'item' : 'items'}`);
  if (bump) {
    dom.cartCount.classList.remove('bump');
    void dom.cartCount.offsetWidth;          // restart the animation
    dom.cartCount.classList.add('bump');
  }

  const saved = Wishlist.ids.size;
  dom.wishlistCount.textContent = String(saved);
  dom.wishlistCount.hidden = saved === 0;
  dom.wishlistLink.setAttribute('aria-label', `Wishlist, ${saved} ${saved === 1 ? 'item' : 'items'}`);
}

function renderWishlistView() {
  const items = [...Wishlist.ids].map(getProduct).filter(Boolean);
  dom.wishlistGrid.replaceChildren(...items.map(createProductCard));
  dom.wishlistGrid.hidden = items.length === 0;
  dom.wishlistEmpty.hidden = items.length > 0;
  dom.wishlistSubtitle.textContent = items.length ? `${items.length} saved ${items.length === 1 ? 'item' : 'items'}` : '';
}

/* Checkout ---------------------------------------------------------------- */
const selectedDelivery = () => dom.checkoutForm.elements.delivery.value || 'standard';
const selectedPayment = () => dom.checkoutForm.elements.payment.value || 'cod';

function renderCheckoutView() {
  const empty = Cart.count() === 0;
  dom.checkoutContent.hidden = empty;
  dom.checkoutEmpty.hidden = !empty;
  if (!empty) renderOrderSummary();
}

function renderOrderSummary() {
  dom.summaryItems.replaceChildren(...Cart.lines.map((line) => {
    const product = getProduct(line.id);
    const opts = formatOptions(line.options);
    return h('li', { class: 'summary-item' },
      h('div', { class: 'summary-thumb' },
        createImage(product, mainImage(product, { w: 120 }), { alt: '', size: 120 }),
        h('span', { class: 'summary-qty', 'aria-label': `Quantity ${line.qty}` }, String(line.qty))),
      h('div', {},
        h('p', { class: 'summary-name' }, product.name),
        opts ? h('p', { class: 'summary-opts' }, opts) : null),
      h('p', { class: 'summary-price' }, formatPrice(unitPrice(product, line.options) * line.qty)));
  }));

  const totals = getDeliveryTotals(selectedDelivery());
  dom.summarySubtotal.textContent = formatPrice(totals.subtotal);
  dom.summaryShipping.textContent = totals.shipping === 0 ? 'Free' : formatPrice(totals.shipping);
  dom.summaryTotal.textContent = formatPrice(totals.total);
  dom.standardFee.textContent = totals.subtotal >= FREE_SHIPPING_THRESHOLD ? 'Free' : formatPrice(DELIVERY_OPTIONS.standard.fee);
  dom.expressFee.textContent = formatPrice(DELIVERY_OPTIONS.express.fee);
}

/** Updates every "Free delivery over [amount]" mention with the selected currency's threshold. */
function renderFreeShippingAmount() {
  $$('.js-free-shipping-amount').forEach((el) => { el.textContent = formatPrice(FREE_SHIPPING_THRESHOLD); });
}

function syncPaymentFields() {
  const isCard = selectedPayment() === 'card';
  dom.cardFields.hidden = !isCard;
  // Disabled fields are skipped by validation and excluded from FormData
  $$('input', dom.cardFields).forEach((input) => {
    input.disabled = !isCard;
    input.required = isCard;
    if (!isCard) {
      input.removeAttribute('aria-invalid');
      const err = document.getElementById(`${input.id}-error`);
      if (err) err.textContent = '';
    }
  });
}

function luhnCheck(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const VALIDATORS = {
  fullName: (v) => (v.trim().length >= 2 ? '' : 'Enter your full name.'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Enter an email address like name@example.com.'),
  phone: (v) => {
    const digits = v.replace(/\D/g, '');
    return /^\+?[\d\s()-]+$/.test(v.trim()) && digits.length >= 7 && digits.length <= 15 ? '' : 'Enter a phone number with 7 to 15 digits.';
  },
  address: (v) => (v.trim().length >= 5 ? '' : 'Enter your street address.'),
  city: (v) => (v.trim().length >= 2 ? '' : 'Enter your city.'),
  region: (v) => (v.trim().length >= 2 ? '' : 'Enter your state or region.'),
  country: (v) => (v ? '' : 'Select your country.'),
  cardName: (v) => (v.trim().length >= 2 ? '' : 'Enter the name shown on the card.'),
  cardNumber: (v) => {
    const digits = v.replace(/\s/g, '');
    if (!/^\d{13,19}$/.test(digits)) return 'Enter a 13 to 19 digit card number.';
    return luhnCheck(digits) ? '' : 'This card number isn’t valid. Check the digits.';
  },
  cardExpiry: (v) => {
    const match = v.trim().match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
    if (!match) return 'Enter the expiry date as MM/YY.';
    const expiryEnd = new Date(2000 + Number(match[2]), Number(match[1]), 1);   // first day after expiry month
    return expiryEnd > new Date() ? '' : 'This card has expired.';
  },
  cardCvc: (v) => (/^\d{3,4}$/.test(v.trim()) ? '' : 'Enter the 3 or 4 digit code on the back of the card.'),
};

function validateField(input) {
  const validator = VALIDATORS[input.name];
  if (!validator || input.disabled) return true;
  const message = validator(input.value);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  const errorEl = document.getElementById(`${input.id}-error`);
  if (errorEl) errorEl.textContent = message;
  return !message;
}

/** Sends the cart to Supabase. Prices and stock are checked on the server (place_order in setup.sql). */
async function submitOrder() {
  const data = new FormData(dom.checkoutForm);
  const field = (name) => String(data.get(name) ?? '').trim();
  const customer = {
    name: field('fullName'), email: field('email'), phone: field('phone'),
    address: field('address'), city: field('city'), region: field('region'), country: field('country'),
  };
  const delivery = selectedDelivery();
  const payment = selectedPayment();          // card details are never sent anywhere

  const { data: result, error } = await db.rpc('place_order', {
    p_customer: customer,
    p_items: Cart.lines.map(({ id, options, qty }) => ({ id, options, qty })),
    p_delivery: delivery,
    p_payment: payment,
  });
  if (error) throw error;

  const [minDays, maxDays] = DELIVERY_OPTIONS[delivery].days;
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); };
  return {
    ...result,
    subtotal: Number(result.subtotal),
    shipping: Number(result.shipping),
    total: Number(result.total),
    customer, delivery, payment,
    eta: [addDays(minDays), addDays(maxDays)],
  };
}

async function handleCheckoutSubmit(event) {
  event.preventDefault();
  if (Cart.count() === 0 || dom.placeOrder.disabled) return;

  const fields = [...dom.checkoutForm.elements].filter((el) => el.name && VALIDATORS[el.name] && !el.disabled);
  const invalid = fields.filter((field) => !validateField(field));
  if (invalid.length) {
    invalid[0].focus();
    toast(`Check ${invalid.length} ${invalid.length === 1 ? 'field' : 'fields'} before placing your order.`, { type: 'error' });
    return;
  }

  dom.placeOrder.disabled = true;
  dom.placeOrder.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Placing order…'));

  try {
    const order = await submitOrder();
    // Reflect the new stock levels locally without a full reload
    order.items.forEach((item) => {
      const product = getProduct(item.id);
      if (product) product.stock = Math.max(0, product.stock - item.qty);
    });
    cardCache.clear();
    writeStorage(STORAGE_KEYS.lastOrder, order);
    Cart.clear();
    dom.checkoutForm.reset();
    $$('[aria-invalid]', dom.checkoutForm).forEach((el) => el.removeAttribute('aria-invalid'));
    syncPaymentFields();
    location.hash = `#/order/${order.id}`;
  } catch (error) {
    // Messages raised by place_order are written for shoppers, so show them directly
    const message = error?.message && !/fetch|network/i.test(error.message)
      ? error.message
      : 'We couldn’t reach the store. Check your connection and try again.';
    toast(message, { type: 'error', duration: 6000 });
    refreshCatalog();            // stock may have changed since the page loaded
  } finally {
    dom.placeOrder.disabled = false;
    dom.placeOrder.replaceChildren('Place order');
  }
}

/* Confirmation ------------------------------------------------------------ */
function renderConfirmation(orderId) {
  const order = readStorage(STORAGE_KEYS.lastOrder, null);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  if (!order || order.id !== orderId) {
    dom.confirmation.replaceChildren(h('div', { class: 'empty-state' },
      icon('alert'),
      h('h1', { tabindex: '-1', 'data-view-heading': '' }, 'We couldn’t find that order'),
      h('p', {}, 'Order details are only kept on the device you ordered from.'),
      h('a', { href: '#/', class: 'btn btn-primary' }, 'Back to the store')));
    $('.icon', dom.confirmation).classList.add('empty-icon');
    return;
  }

  const c = order.customer;
  dom.confirmation.replaceChildren(h('div', { class: 'confirm' },
    h('div', { class: 'confirm-head' },
      h('div', { class: 'confirm-check' }, icon('check')),
      h('h1', { tabindex: '-1', 'data-view-heading': '' }, `Thanks, ${c.name.split(' ')[0]}. Your order is placed.`),
      h('p', { class: 'confirm-number' }, `Order ${order.id}`),
      h('p', { class: 'muted' }, `A confirmation would be sent to ${c.email}. This is a demo, so no email or payment is processed.`)),
    h('div', { class: 'confirm-grid' },
      h('section', { class: 'confirm-card' },
        h('h2', {}, 'Delivery'),
        h('p', {}, `${DELIVERY_OPTIONS[order.delivery].label}, arriving ${fmtDate(order.eta[0])} to ${fmtDate(order.eta[1])}`),
        h('p', {}, `${c.address}, ${c.city}, ${c.region}, ${c.country}`),
        h('p', {}, c.phone)),
      h('section', { class: 'confirm-card' },
        h('h2', {}, 'Payment'),
        h('p', {}, PAYMENT_LABELS[order.payment] ?? 'Pay on delivery'),
        h('p', {}, `Placed ${fmtDate(order.placedAt)}`))),
    h('section', { class: 'order-summary', 'aria-labelledby': 'confirm-items-title' },
      h('h2', { id: 'confirm-items-title' }, 'Items'),
      h('ul', { class: 'summary-items' }, order.items.map((item) => {
        const product = getProduct(item.id) ?? { name: item.name, category: '', images: [] };
        const src = item.image ? sizedImage(item.image, { w: 120 }) : placeholderImage(product);
        return h('li', { class: 'summary-item' },
          h('div', { class: 'summary-thumb' },
            createImage(product, src, { alt: '', size: 120 }),
            h('span', { class: 'summary-qty', 'aria-label': `Quantity ${item.qty}` }, String(item.qty))),
          h('div', {}, h('p', { class: 'summary-name' }, item.name), item.options ? h('p', { class: 'summary-opts' }, item.options) : null),
          h('p', { class: 'summary-price' }, formatPrice(item.unitPrice * item.qty)));
      })),
      h('dl', { class: 'summary-totals' },
        h('div', {}, h('dt', {}, 'Subtotal'), h('dd', {}, formatPrice(order.subtotal))),
        h('div', {}, h('dt', {}, 'Delivery'), h('dd', {}, order.shipping === 0 ? 'Free' : formatPrice(order.shipping))),
        h('div', { class: 'summary-grand' }, h('dt', {}, 'Total'), h('dd', {}, formatPrice(order.total))))),
    h('div', { class: 'confirm-actions' },
      h('a', { href: '#/', class: 'btn btn-primary btn-lg' }, 'Continue shopping'))));
}

/* Toasts ------------------------------------------------------------------ */
function toast(message, { type = 'success', action, duration = 3500 } = {}) {
  const el = h('div', { class: `toast toast-${type}` },
    icon(type === 'error' ? 'alert' : 'check'),
    h('p', {}, message),
    action ? h('button', {
      type: 'button', class: 'toast-action',
      onClick: () => { action.onClick(); dismiss(); },
    }, action.label) : null);

  // Keep at most 3 toasts on screen
  while (dom.toastRegion.children.length >= 3) dom.toastRegion.firstElementChild.remove();
  dom.toastRegion.append(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));

  let timer = setTimeout(dismiss, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1500); });

  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 250);
  }
}

/* Panels: cart drawer and mobile filters ---------------------------------- */
function openPanel(name) {
  ui.lastFocus = document.activeElement;
  ui.openPanel = name;
  dom.overlay.classList.add('is-visible');
  document.body.classList.add('no-scroll');

  if (name === 'cart') {
    dom.cartDrawer.classList.add('is-open');
    dom.cartButton.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => dom.cartClose.focus());
  } else {
    dom.filters.classList.add('is-open');
    dom.filters.setAttribute('role', 'dialog');
    dom.filters.setAttribute('aria-modal', 'true');
    dom.filtersOpen.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => dom.filtersClose.focus());
  }
}

function closePanel({ restoreFocus = true } = {}) {
  if (!ui.openPanel) return;
  const name = ui.openPanel;
  ui.openPanel = null;
  dom.overlay.classList.remove('is-visible');
  document.body.classList.remove('no-scroll');

  if (name === 'cart') {
    dom.cartDrawer.classList.remove('is-open');
    dom.cartButton.setAttribute('aria-expanded', 'false');
  } else {
    dom.filters.classList.remove('is-open');
    dom.filters.removeAttribute('role');
    dom.filters.removeAttribute('aria-modal');
    dom.filtersOpen.setAttribute('aria-expanded', 'false');
  }
  if (restoreFocus && ui.lastFocus?.isConnected) ui.lastFocus.focus();
}

const openCart = () => openPanel('cart');

function trapFocus(event, container) {
  const focusables = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
  else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
}

/* Theme ------------------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  dom.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#141f1b' : '#0f7b5f');
}

/** Rebuilds the currency picker options and reflects the active currency. */
function renderCurrencySelect() {
  dom.currencySelect.replaceChildren(...CURRENCIES.map((c) =>
    h('option', { value: c.code }, c.code)));
  dom.currencySelect.value = currentCurrency;
}

/** Re-renders every price on screen after the shopper switches currency. */
function refreshForCurrency() {
  cardCache.clear();
  renderFreeShippingAmount();
  renderCategoryControls();
  renderHeroFeature();
  renderCart();
  const hash = location.hash || '#/';
  let match;
  if (hash === '#/' || hash === '#') renderGrid();
  else if ((match = hash.match(/^#\/product\/([a-z0-9-]+)$/))) renderProductDetail(match[1]);
  else if (hash === '#/wishlist') renderWishlistView();
  else if (hash === '#/checkout') renderCheckoutView();
  else if ((match = hash.match(/^#\/order\/([A-Z0-9-]+)$/))) renderConfirmation(match[1]);
}

/* -------------------------------------------------------------------------
   7. ROUTING (hash based, so it works on any static host including Vercel)
   ------------------------------------------------------------------------- */
function showView(name, { focus = true } = {}) {
  ui.view = name;
  dom.views.forEach((view) => { view.hidden = view.dataset.view !== name; });
  if (focus) {
    const heading = $(`[data-view="${name}"] [data-view-heading]`);
    heading?.focus({ preventScroll: true });
  }
}

function router() {
  if (!ui.ready) return;                 // routes run once the catalogue has loaded
  const hash = location.hash || '#/';
  const previousView = ui.view;
  if (previousView === 'home') ui.homeScrollY = window.scrollY;
  closePanel({ restoreFocus: false });
  const isFirstLoad = !ui.route;
  ui.route = hash;

  let match;
  if (hash === '#/' || hash === '#') {
    document.title = 'Devhut Stores | Groceries, electronics, home and fashion';
    showView('home', { focus: !isFirstLoad });
    renderGrid();
    if (ui.scrollToResults) {
      ui.scrollToResults = false;
      dom.shop.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo(0, previousView === 'home' ? window.scrollY : ui.homeScrollY);
    }
    return;
  }

  window.scrollTo(0, 0);

  if ((match = hash.match(/^#\/product\/([a-z0-9-]+)$/))) {
    if (renderProductDetail(match[1])) showView('product');
    else { document.title = 'Page not found | Devhut Stores'; showView('notfound'); }
  } else if (hash === '#/wishlist') {
    document.title = 'Wishlist | Devhut Stores';
    renderWishlistView();
    showView('wishlist');
  } else if (hash === '#/checkout') {
    document.title = 'Checkout | Devhut Stores';
    renderCheckoutView();
    showView('checkout');
  } else if ((match = hash.match(/^#\/order\/([A-Z0-9-]+)$/))) {
    document.title = 'Order confirmed | Devhut Stores';
    renderConfirmation(match[1]);
    showView('confirmation');
  } else {
    document.title = 'Page not found | Devhut Stores';
    showView('notfound');
  }
}

/* -------------------------------------------------------------------------
   8. EVENTS & INIT
   ------------------------------------------------------------------------- */
function bindEvents() {
  // Delegated clicks for dynamic content (cards, category chips, shared buttons)
  document.addEventListener('click', (event) => {
    const target = event.target;

    const addBtn = target.closest('[data-add-id]');
    if (addBtn) {
      const product = getProduct(addBtn.dataset.addId);
      const { added } = Cart.add(product.id, {}, 1);
      if (added === 0) toast(`You already have the maximum of ${maxQtyFor(product)} in your cart.`, { type: 'error' });
      else {
        toast(`Added ${product.name} to cart`, { action: { label: 'View cart', onClick: openCart } });
        flashButton(addBtn, 'Added');
      }
      return;
    }

    const wishBtn = target.closest('[data-wish-id]');
    if (wishBtn) {
      const product = getProduct(wishBtn.dataset.wishId);
      const added = Wishlist.toggle(product.id);
      toast(added ? `Saved ${product.name} to wishlist` : `Removed ${product.name} from wishlist`);
      wishBtn.classList.remove('pop');
      void wishBtn.offsetWidth;
      if (added) wishBtn.classList.add('pop');
      return;
    }

    const categoryBtn = target.closest('[data-category]');
    if (categoryBtn) { setCategory(categoryBtn.dataset.category); return; }

    const categoryLink = target.closest('[data-category-link]');
    if (categoryLink) {
      event.preventDefault();
      filters.category = categoryLink.dataset.categoryLink;
      applyFilterChange();
      return;
    }

    if (target.closest('[data-reset-filters]')) { resetFilters(); return; }
    if (target.closest('[data-close-cart]')) { closePanel(); }
  });

  // Skip link: focus <main> without changing the hash route
  dom.skipLink.addEventListener('click', (e) => {
    e.preventDefault();
    dom.main.focus();
  });

  // Search (debounced)
  const debouncedSearch = debounce((value) => setSearch(value), 250);
  dom.searchInput.addEventListener('input', (e) => {
    dom.searchClear.hidden = !e.target.value;
    debouncedSearch(e.target.value);
  });
  dom.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    setSearch(dom.searchInput.value);
    if (ui.view === 'home') dom.shop.scrollIntoView({ behavior: 'smooth', block: 'start' });
    dom.searchInput.blur();
  });
  dom.searchClear.addEventListener('click', () => {
    setSearch('');
    dom.searchInput.focus();
  });

  // "/" focuses search, like many marketplaces
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing && !ui.openPanel) {
      e.preventDefault();
      dom.searchInput.focus();
    }
    if (ui.openPanel) {
      if (e.key === 'Escape') closePanel();
      if (e.key === 'Tab') trapFocus(e, ui.openPanel === 'cart' ? dom.cartDrawer : dom.filters);
    }
  });

  // Filters & sorting
  const debouncedPrice = debounce(readPriceInputs, 350);
  dom.priceMin.addEventListener('input', debouncedPrice);
  dom.priceMax.addEventListener('input', debouncedPrice);
  dom.sortSelect.addEventListener('change', () => {
    filters.sort = dom.sortSelect.value;
    renderGrid();
  });
  dom.filtersOpen.addEventListener('click', () => openPanel('filters'));
  dom.filtersClose.addEventListener('click', () => closePanel());
  dom.filtersApply.addEventListener('click', () => {
    closePanel();
    dom.shop.scrollIntoView({ block: 'start' });
  });
  DESKTOP_QUERY.addEventListener('change', (e) => {
    if (e.matches && ui.openPanel === 'filters') closePanel({ restoreFocus: false });
  });

  // Hero
  dom.heroShop.addEventListener('click', () => {
    filters.sort = 'discount';
    syncFilterControls();
    renderGrid();
    dom.shop.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Cart drawer
  dom.cartButton.addEventListener('click', openCart);
  dom.cartClose.addEventListener('click', () => closePanel());
  dom.overlay.addEventListener('click', () => closePanel());
  dom.checkoutLink.addEventListener('click', () => {
    if (location.hash === '#/checkout') closePanel({ restoreFocus: false });
  });

  // Theme
  dom.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch { /* ignore */ }
  });

  // Currency
  dom.currencySelect.addEventListener('change', () => {
    currentCurrency = dom.currencySelect.value;
    writeStorage(STORAGE_KEYS.currency, currentCurrency);
    refreshForCurrency();
  });

  // Checkout form
  dom.checkoutForm.addEventListener('submit', handleCheckoutSubmit);
  dom.checkoutForm.addEventListener('change', (e) => {
    if (e.target.name === 'delivery') renderOrderSummary();
    if (e.target.name === 'payment') syncPaymentFields();
    if (e.target.tagName === 'SELECT') validateField(e.target);
  });
  dom.checkoutForm.addEventListener('focusout', (e) => {
    if (e.target.value) validateField(e.target);           // don't nag on untouched fields
  });
  dom.checkoutForm.addEventListener('input', (e) => {
    const input = e.target;
    if (input.name === 'cardNumber') {
      input.value = input.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
    }
    if (input.name === 'cardExpiry') {
      const digits = input.value.replace(/\D/g, '').slice(0, 4);
      input.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    }
    if (input.name === 'cardCvc') input.value = input.value.replace(/\D/g, '').slice(0, 4);
    if (input.getAttribute('aria-invalid') === 'true') validateField(input);   // live-clear errors once fixed
  });

  // Keep other tabs in sync (cart/wishlist changed elsewhere)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.cart) { Cart.load(); notify('cart'); }
    if (e.key === STORAGE_KEYS.wishlist) { Wishlist.load(); notify('wishlist'); }
  });

  window.addEventListener('hashchange', router);
}

// React to store changes in one place
subscribe((type) => {
  updateBadges();
  if (type === 'cart') {
    renderCart();
    if (ui.view === 'checkout') renderCheckoutView();
  }
  if (type === 'wishlist') {
    $$('[data-wish-id]').forEach(updateWishButton);
    if (ui.view === 'wishlist') renderWishlistView();
  }
});

function showLoadError(error) {
  dom.grid.hidden = true;
  dom.gridEmpty.hidden = true;
  dom.gridError.hidden = false;
  dom.resultsCount.textContent = '';
  dom.gridErrorText.textContent = error?.message?.includes('config.js')
    ? error.message
    : 'Check your connection and try again.';
  console.error(error);
}

/** Loads (or reloads) the catalogue, then renders everything that depends on it. */
async function loadCatalog() {
  ui.loading = true;
  dom.gridError.hidden = true;
  dom.grid.hidden = false;
  renderSkeletons();
  try {
    await fetchCatalog();
  } catch (error) {
    showLoadError(error);
    return false;
  }
  ui.loading = false;
  Cart.load();
  Wishlist.load();
  renderCurrencySelect();
  renderFreeShippingAmount();
  renderCategoryControls();
  renderHeroFeature();
  renderCart();
  updateBadges();

  const firstLoad = !ui.ready;
  ui.ready = true;
  if (firstLoad) router();
  else if (ui.view === 'home') renderGrid();
  return true;
}

/** Quietly refreshes stock and prices (e.g. after a failed order) without skeletons. */
async function refreshCatalog() {
  try {
    await fetchCatalog();
    renderCurrencySelect();
    cartLineNodes.clear();                 // prices may have changed: rebuild cart lines
    dom.cartItems.replaceChildren();
    Cart.load();
    Cart.save();
    if (ui.view === 'home') renderGrid();
    if (ui.view === 'checkout') renderCheckoutView();
  } catch { /* keep showing what we have */ }
}

function init() {
  cacheDom();
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $('#year').textContent = String(new Date().getFullYear());

  startFlashTimer();
  syncPaymentFields();
  bindEvents();
  dom.gridRetry.addEventListener('click', loadCatalog);
  loadCatalog();
}

document.addEventListener('DOMContentLoaded', init);
