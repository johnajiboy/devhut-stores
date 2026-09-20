'use strict';

/* ==========================================================================
   Devhut Stores — admin.js
   Sign in, manage products (add / edit / delete / stock / visibility / photos
   / options) and manage orders. Security is enforced by the database rules in
   setup.sql: this page can only change data when signed in as an admin.
   All customer and product text is inserted with textContent (never innerHTML).
   ========================================================================== */

/* 1. SETUP --------------------------------------------------------------- */
const CONFIG = window.DEVHUT_CONFIG ?? {};
const isConfigured = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && !CONFIG.supabaseUrl.includes('YOUR-PROJECT'));
const db = isConfigured && window.supabase ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey) : null;

const BUCKET = 'product-images';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
const LOW_STOCK = 5;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatPrice = (n) => money.format(Number(n) || 0);
const formatDateTime = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const state = {
  categories: [],
  products: [],
  orders: [],
  currencies: [],
  productQuery: '',
  productCategory: 'all',
  orderStatus: 'all',
  // Product editor
  editing: null,              // product being edited, or null when adding
  formImages: [],             // current list of image URLs in the editor
  uploadedThisSession: [],    // uploaded in the open editor (deleted if cancelled)
  removedImages: [],          // removed in the open editor (deleted from storage on save)
  saved: false,
  idTouched: false,
  uploading: 0,
};

/* 2. HELPERS ------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const thumbUrl = (url, size = 96) => (/^https:\/\/images\.unsplash\.com\//.test(url)
  ? `${url.split('?')[0]}?auto=format&fit=crop&w=${size}&h=${size}&q=70`
  : url);

/** Path inside our storage bucket for an uploaded image URL, or null for external links. */
function storagePath(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

async function deleteStoredImages(urls) {
  const paths = urls.map(storagePath).filter(Boolean);
  if (!paths.length) return;
  const { error } = await db.storage.from(BUCKET).remove(paths);
  if (error) console.warn('Could not delete some images:', error.message);
}

function toast(message, { type = 'success', duration = 3500 } = {}) {
  const el = h('div', { class: `toast toast-${type}` }, icon(type === 'error' ? 'alert' : 'check'), h('p', {}, message));
  while (dom.toasts.children.length >= 3) dom.toasts.firstElementChild.remove();
  dom.toasts.append(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => { el.classList.remove('is-visible'); setTimeout(() => el.remove(), 250); }, duration);
}

/** Turns Supabase/Postgres errors into plain-English messages. */
function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  const msg = error.message ?? '';
  if (error.code === '23505') return 'A product with this ID already exists. Choose a different ID.';
  if (error.code === '23503') return 'That category no longer exists. Pick another one.';
  if (error.code === '23514') return 'One of the values is out of range. Check prices, stock and rating.';
  if (error.code === '42501' || /row-level security|permission/i.test(msg)) return 'You don’t have permission to do that. Sign in again as an admin.';
  if (/JWT|session/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (/fetch|network/i.test(msg)) return 'Couldn’t reach the server. Check your connection.';
  return msg || fallback;
}

/* 3. DOM ----------------------------------------------------------------- */
const dom = {};
function cacheDom() {
  Object.assign(dom, {
    main: $('#main'),
    boot: $('#boot-view'),
    loginView: $('#login-view'),
    loginForm: $('#login-form'),
    loginEmail: $('#login-email'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
    loginSubmit: $('#login-submit'),
    appView: $('#app-view'),
    dashTitle: $('#dash-title'),
    signedInAs: $('#signed-in-as'),
    signOut: $('#sign-out'),
    themeToggle: $('#theme-toggle'),
    tabs: $$('[role="tab"]'),
    pendingBadge: $('#pending-badge'),
    stats: $('#product-stats'),
    productSearch: $('#product-search'),
    categoryFilter: $('#product-category-filter'),
    addProduct: $('#add-product'),
    productRows: $('#product-rows'),
    productsEmpty: $('#products-empty'),
    orderStatusFilter: $('#order-status-filter'),
    refreshOrders: $('#refresh-orders'),
    orderList: $('#order-list'),
    ordersEmpty: $('#orders-empty'),
    orderCount: $('#order-count'),
    currencyRows: $('#currency-rows'),
    dialog: $('#product-dialog'),
    dialogTitle: $('#dialog-title'),
    form: $('#product-form'),
    formError: $('#product-form-error'),
    saveProduct: $('#save-product'),
    fName: $('#f-name'),
    fId: $('#f-id'),
    fCategory: $('#f-category'),
    imageList: $('#image-list'),
    fileInput: $('#f-images'),
    imageUrl: $('#f-image-url'),
    addImageUrl: $('#add-image-url'),
    uploadStatus: $('#upload-status'),
    variantList: $('#variant-list'),
    addVariant: $('#add-variant'),
    toasts: $('#toast-region'),
  });
}

/* 4. AUTH ---------------------------------------------------------------- */
function showView(name) {
  dom.boot.hidden = name !== 'boot';
  dom.loginView.hidden = name !== 'login';
  dom.appView.hidden = name !== 'app';
  dom.signOut.hidden = name !== 'app';
}

function showLogin(message = '') {
  showView('login');
  dom.loginError.textContent = message;
  dom.loginEmail.focus();
}

async function enterApp(session) {
  const { data: isAdmin, error } = await db.rpc('is_admin');
  if (error || !isAdmin) {
    await db.auth.signOut();
    showLogin(error
      ? friendlyError(error)
      : 'This account isn’t an admin. Add it to the admins table in Supabase (see setup.sql, section 6).');
    return;
  }
  dom.signedInAs.textContent = `Signed in as ${session.user.email}`;
  showView('app');
  dom.dashTitle.focus();
  await Promise.all([loadCategories(), loadProducts(), loadOrders(), loadCurrencies()]);
}

async function handleLogin(event) {
  event.preventDefault();
  const email = dom.loginEmail.value.trim();
  const password = dom.loginPassword.value;
  if (!email || !password) {
    dom.loginError.textContent = 'Enter your email and password.';
    return;
  }
  dom.loginSubmit.disabled = true;
  dom.loginSubmit.textContent = 'Signing in…';
  dom.loginError.textContent = '';

  const { data, error } = await db.auth.signInWithPassword({ email, password });
  dom.loginSubmit.disabled = false;
  dom.loginSubmit.textContent = 'Sign in';

  if (error) {
    dom.loginError.textContent = /invalid/i.test(error.message)
      ? 'Email or password is incorrect.'
      : friendlyError(error);
    dom.loginPassword.select();
    return;
  }
  dom.loginPassword.value = '';
  enterApp(data.session);
}

/* 5. PRODUCTS: LOAD + LIST ---------------------------------------------- */
async function loadCategories() {
  const { data, error } = await db.from('categories').select('*').order('sort');
  if (error) { toast(friendlyError(error), { type: 'error' }); return; }
  state.categories = data;
  dom.categoryFilter.replaceChildren(
    h('option', { value: 'all' }, 'All categories'),
    ...data.map((c) => h('option', { value: c.id }, c.label)));
  dom.fCategory.replaceChildren(
    h('option', { value: '' }, 'Choose a category'),
    ...data.map((c) => h('option', { value: c.id }, `${c.emoji} ${c.label}`)));
}

async function loadProducts() {
  const { data, error } = await db.from('products').select('*').order('featured').order('name');
  if (error) { toast(friendlyError(error), { type: 'error' }); return; }
  state.products = data;
  renderProducts();
}

const categoryLabel = (id) => state.categories.find((c) => c.id === id)?.label ?? id;

function renderStats() {
  const p = state.products;
  const stat = (value, label, warn = false) => h('li', { class: warn && value > 0 ? 'stat-warn' : null },
    h('span', { class: 'stat-value' }, String(value)), h('span', { class: 'stat-label' }, label));
  dom.stats.replaceChildren(
    stat(p.length, 'Products'),
    stat(p.filter((x) => !x.active).length, 'Hidden'),
    stat(p.filter((x) => x.stock > 0 && x.stock <= LOW_STOCK).length, `Low stock (≤${LOW_STOCK})`, true),
    stat(p.filter((x) => x.stock === 0).length, 'Out of stock', true));
}

function renderProducts() {
  renderStats();
  const q = state.productQuery.trim().toLowerCase();
  const list = state.products.filter((p) =>
    (state.productCategory === 'all' || p.category === state.productCategory) &&
    (!q || `${p.name} ${p.brand} ${p.id}`.toLowerCase().includes(q)));

  dom.productRows.replaceChildren(...list.map(productRow));
  dom.productsEmpty.hidden = list.length > 0;
  $('.table-wrap').hidden = list.length === 0;
}

function productRow(p) {
  const img = h('img', { class: 'product-thumb', alt: '', loading: 'lazy', width: 48, height: 48 });
  if (p.images?.[0]) img.src = thumbUrl(p.images[0]);

  const stockInput = h('input', {
    type: 'number', class: 'stock-input', min: 0, step: 1, value: p.stock, inputmode: 'numeric',
    'aria-label': `Stock for ${p.name}`,
  });
  stockInput.addEventListener('change', () => updateStock(p, stockInput));

  const visible = h('input', { type: 'checkbox', checked: p.active, 'aria-label': `Show ${p.name} in store` });
  visible.addEventListener('change', () => toggleActive(p, visible));

  return h('tr', { class: p.active ? null : 'is-hidden-product' },
    h('td', { class: 'cell-product' },
      h('div', { class: 'product-cell' }, img,
        h('div', {},
          h('p', { class: 'product-cell-name' }, p.name),
          h('p', { class: 'product-cell-id' }, p.id)))),
    h('td', { 'data-label': 'Category' }, categoryLabel(p.category)),
    h('td', { 'data-label': 'Price' },
      h('span', { class: 'price-now', style: 'font-size:inherit' }, formatPrice(p.price)),
      p.old_price ? h('s', { class: 'price-old' }, formatPrice(p.old_price)) : null),
    h('td', { 'data-label': 'Stock' }, stockInput,
      p.stock === 0 ? h('span', { class: 'stock-flag' }, 'Out of stock')
        : p.stock <= LOW_STOCK ? h('span', { class: 'stock-flag' }, 'Low') : null),
    h('td', { 'data-label': 'Visible' },
      h('label', { class: 'switch' }, visible, h('span', { class: 'switch-track', 'aria-hidden': 'true' }))),
    h('td', { class: 'cell-actions' },
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-sm', onClick: () => openEditor(p), 'aria-label': `Edit ${p.name}` },
          icon('edit'), 'Edit'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-ghost', onClick: () => deleteProduct(p), 'aria-label': `Delete ${p.name}` },
          icon('trash'), 'Delete'))));
}

function replaceProduct(updated) {
  const i = state.products.findIndex((p) => p.id === updated.id);
  if (i === -1) state.products.push(updated);
  else state.products[i] = updated;
  state.products.sort((a, b) => a.featured - b.featured || a.name.localeCompare(b.name));
}

async function updateStock(product, input) {
  const stock = Number(input.value);
  if (!Number.isInteger(stock) || stock < 0) {
    toast('Stock must be a whole number, 0 or more.', { type: 'error' });
    input.value = product.stock;
    return;
  }
  input.disabled = true;
  const { data, error } = await db.from('products').update({ stock }).eq('id', product.id).select().single();
  input.disabled = false;
  if (error) {
    toast(friendlyError(error), { type: 'error' });
    input.value = product.stock;
    return;
  }
  replaceProduct(data);
  renderProducts();
  toast(`Stock for ${data.name} set to ${stock}`);
}

async function toggleActive(product, checkbox) {
  const active = checkbox.checked;
  checkbox.disabled = true;
  const { data, error } = await db.from('products').update({ active }).eq('id', product.id).select().single();
  checkbox.disabled = false;
  if (error) {
    checkbox.checked = !active;
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  replaceProduct(data);
  renderProducts();
  toast(active ? `${data.name} is now visible in the store` : `${data.name} is now hidden from the store`);
}

async function deleteProduct(product) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Delete "${product.name}"?\n\nThis can't be undone. Tip: switch off "Visible" instead if you might sell it again.`)) return;
  const { error } = await db.from('products').delete().eq('id', product.id);
  if (error) { toast(friendlyError(error), { type: 'error' }); return; }
  await deleteStoredImages(product.images ?? []);
  state.products = state.products.filter((p) => p.id !== product.id);
  renderProducts();
  toast(`Deleted ${product.name}`);
}

/* 6. PRODUCT EDITOR ------------------------------------------------------ */
const FIELD_NAMES = ['name', 'id', 'category', 'price', 'old_price', 'stock', 'featured', 'rating', 'reviews'];
const fieldEl = (name) => dom.form.elements[name];
const errorEl = (input) => document.getElementById(`${input.id}-error`);

function setFieldError(name, message) {
  const input = fieldEl(name);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  const el = errorEl(input);
  if (el) el.textContent = message;
}

function clearFormErrors() {
  FIELD_NAMES.forEach((n) => setFieldError(n, ''));
  dom.formError.textContent = '';
}

function openEditor(product = null) {
  state.editing = product;
  state.formImages = [...(product?.images ?? [])];
  state.uploadedThisSession = [];
  state.removedImages = [];
  state.saved = false;
  state.idTouched = Boolean(product);
  clearFormErrors();
  dom.form.reset();

  const f = dom.form.elements;
  dom.dialogTitle.textContent = product ? `Edit ${product.name}` : 'Add product';
  f.name.value = product?.name ?? '';
  f.id.value = product?.id ?? '';
  f.id.readOnly = Boolean(product);
  f.brand.value = product?.brand ?? '';
  f.category.value = product?.category ?? (state.productCategory !== 'all' ? state.productCategory : '');
  f.description.value = product?.description ?? '';
  f.highlights.value = (product?.highlights ?? []).join('\n');
  f.price.value = product?.price ?? '';
  f.old_price.value = product?.old_price ?? '';
  f.stock.value = product?.stock ?? 0;
  f.featured.value = product?.featured ?? 100;
  f.rating.value = product?.rating ?? 0;
  f.reviews.value = product?.reviews ?? 0;
  f.active.checked = product ? product.active : true;
  f.is_new.checked = product ? product.is_new : true;

  dom.variantList.replaceChildren(...(product?.variants ?? []).map(variantEditor));
  dom.uploadStatus.textContent = '';
  renderImageList();
  dom.dialog.showModal();
  dom.fName.focus();
}

async function closeEditor() {
  if (state.uploading > 0) {
    toast('Please wait for photos to finish uploading.', { type: 'error' });
    return;
  }
  dom.dialog.close();
}

// Runs whenever the dialog closes (Save, Cancel, X or Esc)
async function onDialogClose() {
  if (!state.saved && state.uploadedThisSession.length) {
    await deleteStoredImages(state.uploadedThisSession);      // tidy up unsaved uploads
  }
  state.uploadedThisSession = [];
  state.removedImages = [];
}

/* Images in the editor */
function renderImageList() {
  dom.imageList.replaceChildren(...state.formImages.map((url, i) =>
    h('li', { class: 'image-item' },
      h('img', { src: thumbUrl(url, 224), alt: `Photo ${i + 1}`, width: 112, height: 112 }),
      i === 0 ? h('span', { class: 'tag tag-new' }, 'Main') : null,
      h('div', { class: 'image-item-actions' },
        h('button', { type: 'button', disabled: i === 0, onClick: () => moveImageToFront(i), 'aria-label': `Make photo ${i + 1} the main photo` }, 'Make main'),
        h('button', { type: 'button', class: 'remove', onClick: () => removeImage(i), 'aria-label': `Remove photo ${i + 1}` }, 'Remove')))));
}

function moveImageToFront(i) {
  const [url] = state.formImages.splice(i, 1);
  state.formImages.unshift(url);
  renderImageList();
}

function removeImage(i) {
  const [url] = state.formImages.splice(i, 1);
  if (state.uploadedThisSession.includes(url)) {
    deleteStoredImages([url]);
    state.uploadedThisSession = state.uploadedThisSession.filter((u) => u !== url);
  } else {
    state.removedImages.push(url);            // deleted from storage only when saved
  }
  renderImageList();
}

async function uploadFiles(files) {
  const valid = [];
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) toast(`${file.name}: only JPG, PNG or WebP images`, { type: 'error' });
    else if (file.size > MAX_IMAGE_BYTES) toast(`${file.name} is larger than 5MB`, { type: 'error' });
    else valid.push(file);
  }
  if (!valid.length) return;

  state.uploading += valid.length;
  dom.saveProduct.disabled = true;
  dom.uploadStatus.textContent = `Uploading ${valid.length} photo${valid.length > 1 ? 's' : ''}…`;

  await Promise.all(valid.map(async (file) => {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const folder = slugify(dom.fId.value) || 'new';
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000' });
    if (error) {
      toast(`${file.name}: ${friendlyError(error)}`, { type: 'error' });
    } else {
      const { data } = db.storage.from(BUCKET).getPublicUrl(path);
      state.formImages.push(data.publicUrl);
      state.uploadedThisSession.push(data.publicUrl);
    }
    state.uploading -= 1;
  }));

  dom.saveProduct.disabled = false;
  dom.uploadStatus.textContent = '';
  renderImageList();
}

function addImageLink() {
  const value = dom.imageUrl.value.trim();
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || url.protocol !== 'https:') {
    toast('Enter a full image link starting with https://', { type: 'error' });
    dom.imageUrl.focus();
    return;
  }
  if (state.formImages.includes(url.href)) {
    toast('That photo is already added.', { type: 'error' });
    return;
  }
  state.formImages.push(url.href);
  dom.imageUrl.value = '';
  renderImageList();
}

/* Variants in the editor */
let variantCounter = 0;
function variantEditor(variant = { name: '', options: [] }) {
  variantCounter += 1;
  const n = variantCounter;
  const nameInput = h('input', { type: 'text', id: `vg-name-${n}`, class: 'vg-name', maxlength: 40, placeholder: 'e.g. Size', value: variant.name });
  const optionsInput = h('textarea', { id: `vg-options-${n}`, class: 'vg-options', rows: 3, placeholder: 'S\nM\nL\nXL | 5' });
  optionsInput.value = variant.options.map((o) => (o.delta ? `${o.label} | ${o.delta}` : o.label)).join('\n');

  const wrap = h('div', { class: 'variant-edit' },
    h('div', { class: 'field' }, h('label', { for: nameInput.id }, 'Group name'), nameInput),
    h('div', { class: 'field' }, h('label', { for: optionsInput.id }, 'Options (one per line)'), optionsInput),
    h('button', {
      type: 'button', class: 'icon-btn btn-danger-ghost', 'aria-label': 'Remove this option group',
      onClick: () => { wrap.remove(); dom.addVariant.focus(); },
    }, icon('trash')));
  return wrap;
}

/** Reads the option groups. Returns { variants } or { error }. */
function readVariants() {
  const variants = [];
  for (const group of $$('.variant-edit', dom.variantList)) {
    const name = $('.vg-name', group).value.trim();
    const lines = $('.vg-options', group).value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!name && !lines.length) continue;                       // empty group: ignore
    if (!name) return { error: 'Give every option group a name, e.g. Size or Colour.' };
    if (!lines.length) return { error: `Add at least one option to "${name}".` };
    if (variants.some((v) => v.name.toLowerCase() === name.toLowerCase())) return { error: `There are two groups called "${name}".` };

    const options = [];
    for (const line of lines) {
      const [rawLabel, rawDelta] = line.split('|').map((s) => s.trim());
      const label = rawLabel.slice(0, 40);
      if (!label) return { error: `An option in "${name}" is missing its name.` };
      if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) return { error: `"${label}" appears twice in "${name}".` };
      const delta = rawDelta ? Number(rawDelta.replace(/[$,\s]/g, '')) : 0;
      if (!Number.isFinite(delta) || delta < 0) return { error: `The extra price for "${label}" must be a number, e.g. ${label} | 10` };
      options.push(delta ? { label, delta: Math.round(delta * 100) / 100 } : { label });
    }
    variants.push({ name: name.slice(0, 40), options });
  }
  return { variants };
}

/* Save */
function readAndValidate() {
  clearFormErrors();
  const f = dom.form.elements;
  const num = (name) => (f[name].value.trim() === '' ? null : Number(f[name].value));
  const errors = {};

  const values = {
    id: f.id.value.trim(),
    name: f.name.value.trim(),
    brand: f.brand.value.trim(),
    category: f.category.value,
    description: f.description.value.trim(),
    highlights: f.highlights.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12),
    price: num('price'),
    old_price: num('old_price'),
    stock: num('stock'),
    featured: num('featured') ?? 100,
    rating: num('rating') ?? 0,
    reviews: num('reviews') ?? 0,
    active: f.active.checked,
    is_new: f.is_new.checked,
    images: [...state.formImages],
  };

  if (values.name.length < 2) errors.name = 'Enter a product name.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.id)) errors.id = 'Use lowercase letters, numbers and single hyphens only.';
  else if (!state.editing && state.products.some((p) => p.id === values.id)) errors.id = 'This ID is already used by another product.';
  if (!values.category) errors.category = 'Choose a category.';
  if (values.price == null || !Number.isFinite(values.price) || values.price < 0) errors.price = 'Enter a price of 0 or more.';
  if (values.old_price != null && (!Number.isFinite(values.old_price) || values.old_price <= (values.price ?? 0))) {
    errors.old_price = 'Must be higher than the price, or leave it empty.';
  }
  if (values.stock == null || !Number.isInteger(values.stock) || values.stock < 0) errors.stock = 'Enter a whole number, 0 or more.';
  if (!Number.isInteger(values.featured)) errors.featured = 'Enter a whole number.';
  if (!Number.isFinite(values.rating) || values.rating < 0 || values.rating > 5) errors.rating = 'Enter a rating from 0 to 5.';
  if (!Number.isInteger(values.reviews) || values.reviews < 0) errors.reviews = 'Enter a whole number, 0 or more.';

  Object.entries(errors).forEach(([name, message]) => setFieldError(name, message));

  const { variants, error: variantError } = readVariants();
  if (Object.keys(errors).length || variantError) {
    dom.formError.textContent = variantError ?? 'Please fix the highlighted fields.';
    const first = FIELD_NAMES.find((n) => errors[n]);
    (first ? fieldEl(first) : dom.addVariant).focus();
    return null;
  }
  values.rating = Math.round(values.rating * 10) / 10;
  values.variants = variants;
  return values;
}

async function saveProduct(event) {
  event.preventDefault();
  if (state.uploading > 0) return;
  const values = readAndValidate();
  if (!values) return;

  dom.saveProduct.disabled = true;
  dom.saveProduct.textContent = 'Saving…';

  const { id, ...fields } = values;
  const request = state.editing
    ? db.from('products').update(fields).eq('id', state.editing.id).select().single()
    : db.from('products').insert({ id, ...fields }).select().single();
  const { data, error } = await request;

  dom.saveProduct.disabled = false;
  dom.saveProduct.textContent = 'Save product';

  if (error) {
    dom.formError.textContent = friendlyError(error);
    if (error.code === '23505') setFieldError('id', 'This ID is already used by another product.');
    return;
  }

  state.saved = true;
  await deleteStoredImages(state.removedImages);
  replaceProduct(data);
  renderProducts();
  dom.dialog.close();
  toast(state.editing ? `Saved changes to ${data.name}` : `Added ${data.name}`);
}

/* 7. ORDERS -------------------------------------------------------------- */
async function loadOrders() {
  dom.refreshOrders.disabled = true;
  let query = db.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
  if (state.orderStatus !== 'all') query = query.eq('status', state.orderStatus);
  const [{ data, error }, pending] = await Promise.all([
    query,
    db.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  dom.refreshOrders.disabled = false;
  if (error) { toast(friendlyError(error), { type: 'error' }); return; }
  state.orders = data;
  const pendingCount = pending.count ?? 0;
  dom.pendingBadge.hidden = pendingCount === 0;
  dom.pendingBadge.textContent = String(pendingCount);
  renderOrders();
}

function renderOrders() {
  dom.orderList.replaceChildren(...state.orders.map(orderCard));
  dom.ordersEmpty.hidden = state.orders.length > 0;
  dom.orderCount.textContent = state.orders.length ? `${state.orders.length} order${state.orders.length === 1 ? '' : 's'}` : '';
}

function orderCard(order) {
  const c = order.customer ?? {};
  const statusSelect = h('select', { class: 'select select-sm status-select', 'aria-label': `Status for order ${order.id}` },
    ORDER_STATUSES.map((s) => h('option', { value: s, selected: s === order.status }, capitalise(s))));
  statusSelect.addEventListener('change', () => updateOrderStatus(order, statusSelect));

  const phoneHref = `tel:${String(c.phone ?? '').replace(/[^\d+]/g, '')}`;
  const card = h('article', { class: 'order-card', dataset: { status: order.status } },
    h('div', { class: 'order-top' },
      h('div', {},
        h('p', { class: 'order-id' }, order.id),
        h('p', { class: 'order-date' }, formatDateTime(order.created_at))),
      h('p', { class: 'order-total' }, formatPrice(order.total)),
      statusSelect),
    h('div', { class: 'order-grid' },
      h('div', { class: 'order-block' },
        h('h3', {}, 'Customer'),
        h('p', {}, c.name ?? ''),
        c.email ? h('p', {}, h('a', { href: `mailto:${c.email}` }, c.email)) : null,
        c.phone ? h('p', {}, h('a', { href: phoneHref }, c.phone)) : null,
        h('p', {}, [c.address, c.city, c.region, c.country].filter(Boolean).join(', '))),
      h('div', { class: 'order-block' },
        h('h3', {}, 'Items'),
        h('ul', { class: 'order-items' }, (order.items ?? []).map((item) =>
          h('li', {},
            h('span', {}, `${item.qty} × ${item.name}`, item.options ? h('span', { class: 'muted' }, ` (${item.options})`) : null),
            h('span', {}, formatPrice(item.unitPrice * item.qty))))))),
    h('p', { class: 'order-meta' },
      `${capitalise(order.delivery)} delivery (${Number(order.shipping) === 0 ? 'free' : formatPrice(order.shipping)}) · `,
      order.payment === 'card' ? 'Card (demo)' : 'Pay on delivery',
      ` · Subtotal ${formatPrice(order.subtotal)}`));
  return card;
}

async function updateOrderStatus(order, select) {
  const status = select.value;
  select.disabled = true;
  const { error } = await db.from('orders').update({ status }).eq('id', order.id);
  select.disabled = false;
  if (error) {
    select.value = order.status;
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  order.status = status;
  select.closest('.order-card').dataset.status = status;
  toast(`Order ${order.id} marked as ${status}`);
  // Refresh the pending badge without re-rendering the list
  const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  dom.pendingBadge.hidden = !count;
  dom.pendingBadge.textContent = String(count ?? 0);
}

/* 7b. CURRENCIES ---------------------------------------------------------- */
async function loadCurrencies() {
  const { data, error } = await db.from('currencies').select('*').order('sort');
  if (error) { toast(friendlyError(error), { type: 'error' }); return; }
  state.currencies = data;
  renderCurrencies();
}

function renderCurrencies() {
  dom.currencyRows.replaceChildren(...state.currencies.map(currencyRow));
}

function currencyRow(c) {
  const isBase = c.code === 'USD';

  const rateInput = h('input', {
    type: 'number', class: 'stock-input', min: 0, step: 0.0001, value: c.rate, inputmode: 'decimal',
    disabled: isBase, 'aria-label': `Rate for ${c.name}`,
  });
  rateInput.addEventListener('change', () => updateCurrencyRate(c, rateInput));

  const enabled = h('input', { type: 'checkbox', checked: c.enabled, 'aria-label': `Show ${c.name} to shoppers` });
  enabled.addEventListener('change', () => toggleCurrencyEnabled(c, enabled));

  return h('tr', {},
    h('td', { 'data-label': 'Currency' },
      h('p', { class: 'product-cell-name' }, `${c.code} — ${c.name}`),
      isBase ? h('p', { class: 'product-cell-id' }, 'Base currency: prices are stored in USD') : null),
    h('td', { 'data-label': 'Rate' }, rateInput),
    h('td', { 'data-label': 'Visible to shoppers' },
      h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-track', 'aria-hidden': 'true' }))));
}

async function updateCurrencyRate(currency, input) {
  const rate = Number(input.value);
  if (!Number.isFinite(rate) || rate <= 0) {
    toast('Rate must be a number greater than 0.', { type: 'error' });
    input.value = currency.rate;
    return;
  }
  input.disabled = true;
  const { error } = await db.from('currencies').update({ rate }).eq('code', currency.code);
  input.disabled = false;
  if (error) {
    toast(friendlyError(error), { type: 'error' });
    input.value = currency.rate;
    return;
  }
  currency.rate = rate;
  toast(`${currency.code} rate updated`);
}

async function toggleCurrencyEnabled(currency, checkbox) {
  const enabled = checkbox.checked;
  checkbox.disabled = true;
  const { error } = await db.from('currencies').update({ enabled }).eq('code', currency.code);
  checkbox.disabled = false;
  if (error) {
    checkbox.checked = !enabled;
    toast(friendlyError(error), { type: 'error' });
    return;
  }
  currency.enabled = enabled;
  toast(enabled ? `${currency.code} is now available to shoppers` : `${currency.code} is now hidden from shoppers`);
}

/* 8. TABS + THEME -------------------------------------------------------- */
function selectTab(tab) {
  dom.tabs.forEach((t) => {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
  });
  tab.focus();
  if (tab.id === 'tab-orders') loadOrders();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  dom.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

/* 9. EVENTS + INIT ------------------------------------------------------- */
function bindEvents() {
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.signOut.addEventListener('click', async () => {
    await db.auth.signOut();
    showLogin();
  });

  dom.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('devhut:theme', next); } catch { /* ignore */ }
  });

  dom.tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = dom.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + dom.tabs.length) % dom.tabs.length];
      selectTab(next);
    });
  });

  dom.productSearch.addEventListener('input', debounce(() => {
    state.productQuery = dom.productSearch.value;
    renderProducts();
  }, 200));
  dom.categoryFilter.addEventListener('change', () => {
    state.productCategory = dom.categoryFilter.value;
    renderProducts();
  });
  dom.addProduct.addEventListener('click', () => openEditor());

  dom.orderStatusFilter.addEventListener('change', () => {
    state.orderStatus = dom.orderStatusFilter.value;
    loadOrders();
  });
  dom.refreshOrders.addEventListener('click', loadOrders);

  // Editor
  dom.form.addEventListener('submit', saveProduct);
  $$('[data-close-dialog]', dom.dialog).forEach((btn) => btn.addEventListener('click', closeEditor));
  dom.dialog.addEventListener('cancel', (e) => {       // Esc key
    e.preventDefault();
    closeEditor();
  });
  dom.dialog.addEventListener('close', onDialogClose);
  dom.fName.addEventListener('input', () => {
    if (!state.editing && !state.idTouched) dom.fId.value = slugify(dom.fName.value);
  });
  dom.fId.addEventListener('input', () => { state.idTouched = true; });
  dom.fileInput.addEventListener('change', () => {
    uploadFiles([...dom.fileInput.files]);
    dom.fileInput.value = '';
  });
  dom.addImageUrl.addEventListener('click', addImageLink);
  dom.imageUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addImageLink(); }
  });
  dom.addVariant.addEventListener('click', () => {
    const editor = variantEditor();
    dom.variantList.append(editor);
    $('.vg-name', editor).focus();
  });
}

async function init() {
  cacheDom();
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

  if (!db) {
    showLogin(window.supabase
      ? 'Not connected yet: add your Supabase URL and anon key to config.js.'
      : 'Couldn’t load Supabase. Check your internet connection and refresh.');
    dom.loginSubmit.disabled = true;
    return;
  }

  bindEvents();
  db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showLogin('');
  });

  const { data: { session } } = await db.auth.getSession();
  if (session) enterApp(session);
  else showLogin();
}

document.addEventListener('DOMContentLoaded', init);
