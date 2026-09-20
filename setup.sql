-- =====================================================================
-- Devhut Stores: Supabase setup
-- Run once: Supabase dashboard > SQL Editor > New query > paste > Run.
-- Safe to run again (uses IF NOT EXISTS, OR REPLACE and ON CONFLICT).
-- BEFORE RUNNING: replace you@example.com in section 6 with your admin email.
-- =====================================================================

-- 1. TABLES -----------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  label text not null,
  emoji text not null default '🛍️',
  sort int not null default 100
);

create table if not exists public.products (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null check (length(name) between 2 and 120),
  brand text not null default '',
  category text not null references public.categories (id) on update cascade,
  price numeric(10,2) not null check (price >= 0),
  old_price numeric(10,2) check (old_price is null or old_price >= 0),
  rating numeric(2,1) not null default 0 check (rating between 0 and 5),
  reviews int not null default 0 check (reviews >= 0),
  stock int not null default 0 check (stock >= 0),
  featured int not null default 100,
  is_new boolean not null default false,
  active boolean not null default true,
  images text[] not null default '{}',
  description text not null default '',
  highlights text[] not null default '{}',
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  created_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  customer jsonb not null,
  items jsonb not null,
  delivery text not null,
  payment text not null,
  subtotal numeric(10,2) not null,
  shipping numeric(10,2) not null,
  total numeric(10,2) not null
);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at before update on public.products
  for each row execute function public.touch_updated_at();

-- 2. ADMIN CHECK + SECURITY RULES (Row Level Security) -----------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.admins enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;

drop policy if exists "admins read own row" on public.admins;
create policy "admins read own row" on public.admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "anyone reads categories" on public.categories;
create policy "anyone reads categories" on public.categories
  for select to anon, authenticated using (true);

drop policy if exists "admins manage categories" on public.categories;
create policy "admins manage categories" on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "anyone reads active products" on public.products;
create policy "anyone reads active products" on public.products
  for select to anon, authenticated using (active or public.is_admin());

drop policy if exists "admins manage products" on public.products;
create policy "admins manage products" on public.products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Shoppers can't read or write orders directly: they only use place_order() below
drop policy if exists "admins manage orders" on public.orders;
create policy "admins manage orders" on public.orders
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 3. PLACE ORDER -------------------------------------------------------
-- Prices, variant costs, stock and delivery are all calculated here on the
-- server, so a shopper can't change prices in their browser.
create or replace function public.place_order(
  p_customer jsonb, p_items jsonb, p_delivery text, p_payment text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_customer jsonb;
  v_item jsonb;
  v_product public.products%rowtype;
  v_variant jsonb;
  v_option jsonb;
  v_chosen text;
  v_qty int;
  v_unit numeric;
  v_options_text text;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_shipping numeric;
  v_id text;
begin
  if p_delivery is null or p_delivery not in ('standard', 'express') then
    raise exception 'Choose a valid delivery option.';
  end if;
  if p_payment is null or p_payment not in ('cod', 'card') then
    raise exception 'Choose a valid payment option.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'Your cart is empty.';
  end if;

  -- Keep only known customer fields, trimmed and length-limited
  v_customer := jsonb_build_object(
    'name',    left(btrim(coalesce(p_customer->>'name', '')), 100),
    'email',   left(btrim(coalesce(p_customer->>'email', '')), 200),
    'phone',   left(btrim(coalesce(p_customer->>'phone', '')), 30),
    'address', left(btrim(coalesce(p_customer->>'address', '')), 200),
    'city',    left(btrim(coalesce(p_customer->>'city', '')), 100),
    'region',  left(btrim(coalesce(p_customer->>'region', '')), 100),
    'country', left(btrim(coalesce(p_customer->>'country', '')), 60)
  );
  if v_customer->>'name' = '' or v_customer->>'phone' = '' or v_customer->>'address' = ''
     or v_customer->>'city' = '' or v_customer->>'country' = ''
     or v_customer->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please complete your contact and delivery details.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := case when (v_item->>'qty') ~ '^\d{1,3}$' then (v_item->>'qty')::int else null end;
    if v_qty is null or v_qty < 1 or v_qty > 10 then
      raise exception 'Invalid quantity in your cart.';
    end if;

    select * into v_product from public.products
      where id = v_item->>'id' and active
      for update;                                   -- lock the row while we reduce stock
    if not found then
      raise exception 'An item in your cart is no longer available.';
    end if;
    if v_product.stock < v_qty then
      raise exception 'Only % left of %. Please update your cart.', v_product.stock, v_product.name;
    end if;

    v_unit := v_product.price;
    v_options_text := '';
    for v_variant in select * from jsonb_array_elements(v_product.variants) loop
      v_chosen := v_item->'options'->>(v_variant->>'name');
      select o into v_option from jsonb_array_elements(v_variant->'options') o
        where o->>'label' = v_chosen limit 1;
      if v_option is null then
        raise exception 'Please choose a valid % for %.', v_variant->>'name', v_product.name;
      end if;
      v_unit := v_unit + coalesce((v_option->>'delta')::numeric, 0);
      v_options_text := v_options_text
        || case when v_options_text = '' then '' else ', ' end
        || (v_variant->>'name') || ': ' || v_chosen;
    end loop;

    update public.products set stock = stock - v_qty where id = v_product.id;

    v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id', v_product.id, 'name', v_product.name, 'options', v_options_text,
      'qty', v_qty, 'unitPrice', round(v_unit, 2), 'image', v_product.images[1]
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  v_shipping := case
    when p_delivery = 'express' then 14.99
    when v_subtotal >= 100 then 0
    else 5.99 end;
  v_id := 'DH-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

  insert into public.orders (id, customer, items, delivery, payment, subtotal, shipping, total)
  values (v_id, v_customer, v_lines, p_delivery, p_payment, v_subtotal, v_shipping, v_subtotal + v_shipping);

  return jsonb_build_object(
    'id', v_id, 'items', v_lines, 'subtotal', v_subtotal,
    'shipping', v_shipping, 'total', v_subtotal + v_shipping, 'placedAt', now()
  );
end $$;

revoke all on function public.place_order(jsonb, jsonb, text, text) from public;
grant execute on function public.place_order(jsonb, jsonb, text, text) to anon, authenticated;

-- 4. IMAGE STORAGE -----------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "admins upload product images" on storage.objects;
create policy "admins upload product images" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admins update product images" on storage.objects;
create policy "admins update product images" on storage.objects
  for update to authenticated using (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admins delete product images" on storage.objects;
create policy "admins delete product images" on storage.objects
  for delete to authenticated using (bucket_id = 'product-images' and public.is_admin());

-- 5. SAMPLE DATA (skipped for rows that already exist)
insert into public.categories (id, label, emoji, sort) values
  ('groceries', 'Groceries', '🥑', 10),
  ('electronics', 'Electronics', '🎧', 20),
  ('gadgets', 'Phones & gadgets', '📱', 30),
  ('home', 'Home & kitchen', '🏠', 40),
  ('fashion', 'Fashion', '👟', 50)
on conflict (id) do nothing;

insert into public.products (id, name, brand, category, price, old_price, rating, reviews, stock, featured, is_new, images, description, highlights, variants) values
  ('hass-avocados', 'Hass Avocados', 'FreshFarm', 'groceries', 6.49, 7.99, 4.6, 312, 40, 3, false, array['https://images.unsplash.com/photo-1523049673857-eb18f1d7b578'],
   'Creamy, ready-to-eat Hass avocados picked at peak ripeness. Great on toast, in salads or blended into guacamole.',
   array['Ripe within 1–2 days', 'Sourced from local farms', 'Packed in recyclable trays'],
   '[{"name":"Pack size","options":[{"label":"4 pack"},{"label":"8 pack","delta":5.5}]}]'::jsonb),
  ('arabica-coffee', 'Single-Origin Arabica Coffee Beans, 500g', 'Highland Roast', 'groceries', 14.5, null, 4.8, 528, 25, 6, false, array['https://images.unsplash.com/photo-1447933601403-0c6688de566e'],
   'Medium-roast Arabica with notes of dark chocolate and citrus. Roasted in small batches and sealed with a one-way valve for freshness.',
   array['100% Arabica', 'Medium roast', 'Resealable bag'],
   '[{"name":"Grind","options":[{"label":"Whole bean"},{"label":"Espresso"},{"label":"Filter"}]}]'::jsonb),
  ('olive-oil', 'Extra Virgin Olive Oil, 1L', 'Olea', 'groceries', 11.99, 13.99, 4.5, 204, 30, 12, false, array['https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5'],
   'Cold-pressed extra virgin olive oil with a smooth, peppery finish. Ideal for dressings, dipping and everyday cooking.',
   array['Cold pressed', 'Glass bottle', 'Best before 18 months from harvest'],
   '[]'::jsonb),
  ('bananas', 'Organic Bananas, 1kg', 'FreshFarm', 'groceries', 2.99, null, 4.4, 145, 60, 15, false, array['https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e'],
   'Naturally sweet organic bananas, perfect for breakfast, smoothies and baking.',
   array['Certified organic', 'Rich in potassium'],
   '[]'::jsonb),
  ('aerosound-headphones', 'AeroSound Wireless Headphones', 'AeroSound', 'electronics', 89.99, 129.99, 4.7, 1284, 18, 1, false, array['https://images.unsplash.com/photo-1505740420928-5e560c06d30e'],
   'Over-ear Bluetooth headphones with active noise cancellation, 40-hour battery life and plush memory-foam cushions for all-day comfort.',
   array['Active noise cancellation', '40-hour battery', 'USB-C fast charging: 10 min = 5 hours'],
   '[{"name":"Colour","options":[{"label":"Black"},{"label":"White"},{"label":"Navy"}]}]'::jsonb),
  ('instant-camera', 'Instant Film Camera', 'Snapix', 'electronics', 74, null, 4.5, 390, 4, 9, true, array['https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f'],
   'Print credit-card-sized photos in seconds. Automatic exposure, a selfie mirror and a built-in flash make it easy for anyone.',
   array['Auto exposure', 'Selfie mirror', 'Uses standard mini instant film'],
   '[{"name":"Colour","options":[{"label":"Mint"},{"label":"Blush"},{"label":"Charcoal"}]}]'::jsonb),
  ('ultraslim-laptop', 'UltraSlim 14" Laptop', 'Kova', 'electronics', 649, 749, 4.6, 211, 9, 4, false, array['https://images.unsplash.com/photo-1496181133206-80ce9b88a853'],
   'A 1.3kg aluminium laptop with a sharp 14-inch display, all-day battery and a backlit keyboard. Built for study, work and streaming.',
   array['14" Full HD IPS display', 'Up to 12 hours battery', 'Wi-Fi 6 and USB-C charging'],
   '[{"name":"Memory","options":[{"label":"8GB"},{"label":"16GB","delta":120}]},{"name":"Storage","options":[{"label":"256GB SSD"},{"label":"512GB SSD","delta":80}]}]'::jsonb),
  ('bluetooth-speaker', 'Portable Bluetooth Speaker', 'AeroSound', 'electronics', 45.99, 59.99, 4.3, 677, 35, 10, false, array['https://images.unsplash.com/photo-1608043152269-423dbba4e7e1'],
   'Rugged, water-resistant speaker with deep bass and 12 hours of playtime. Pair two for stereo sound.',
   array['IPX7 water resistant', '12-hour battery', 'Stereo pairing'],
   '[]'::jsonb),
  ('nova-x-phone', 'Nova X Smartphone', 'Nova', 'gadgets', 299, 349, 4.4, 956, 22, 2, false, array['https://images.unsplash.com/photo-1511707171634-5f897ff02aa9'],
   '6.5-inch display, 50MP dual camera and a 5000mAh battery that lasts all day. Dual SIM with 4G support.',
   array['50MP dual camera', '5000mAh battery', 'Dual SIM'],
   '[{"name":"Storage","options":[{"label":"128GB"},{"label":"256GB","delta":60}]},{"name":"Colour","options":[{"label":"Graphite"},{"label":"Silver"}]}]'::jsonb),
  ('pulsefit-watch', 'PulseFit Smartwatch', 'PulseFit', 'gadgets', 119, null, 4.2, 433, 15, 7, true, array['https://images.unsplash.com/photo-1579586337278-3befd40fd17a'],
   'Track steps, sleep and heart rate, and get call and message alerts on your wrist. Up to 7 days of battery life.',
   array['Heart-rate and sleep tracking', '7-day battery', 'Water resistant to 50m'],
   '[{"name":"Strap","options":[{"label":"Silicone"},{"label":"Leather","delta":15}]}]'::jsonb),
  ('classic-watch', 'Classic Analog Watch', 'Heritage', 'fashion', 59, 79, 4.5, 188, 12, 13, false, array['https://images.unsplash.com/photo-1523275335684-37898b6baf30'],
   'A minimalist analog watch with a stainless steel case and a scratch-resistant mineral glass face.',
   array['Stainless steel case', 'Japanese quartz movement', '2-year warranty'],
   '[]'::jsonb),
  ('table-lamp', 'Ceramic Table Lamp', 'Nest & Co', 'home', 39.99, null, 4.3, 97, 20, 11, false, array['https://images.unsplash.com/photo-1507473885765-e6ed057f782c'],
   'A warm, hand-glazed ceramic lamp with a linen shade. Adds soft light to bedrooms and living rooms.',
   array['Hand-glazed base', 'E27 bulb fitting', 'Inline on/off switch'],
   '[{"name":"Finish","options":[{"label":"Sand"},{"label":"Charcoal"}]}]'::jsonb),
  ('house-plant', 'Indoor Potted Plant', 'Nest & Co', 'home', 24.5, null, 4.7, 142, 14, 14, false, array['https://images.unsplash.com/photo-1485955900006-10f4d324d411'],
   'A low-maintenance leafy plant in a matte ceramic pot. Thrives in bright, indirect light.',
   array['Pot included', 'Pet-safe variety', 'Care card in the box'],
   '[{"name":"Size","options":[{"label":"Medium"},{"label":"Large","delta":12}]}]'::jsonb),
  ('electric-kettle', 'Stainless Steel Electric Kettle, 1.7L', 'Kitchenly', 'home', 29.99, 39.99, 4.4, 612, 3, 8, false, array['https://images.unsplash.com/photo-1594213114663-d94db9b17125'],
   'Rapid-boil 2200W kettle with auto shut-off, boil-dry protection and a 360° swivel base.',
   array['2200W rapid boil', 'Auto shut-off', 'Limescale filter'],
   '[]'::jsonb),
  ('cotton-tee', 'Everyday Cotton T-Shirt', 'Basics Lab', 'fashion', 14.99, null, 4.3, 842, 50, 16, false, array['https://images.unsplash.com/photo-1521572163474-6864f9cf17ab'],
   'Soft, breathable 100% cotton tee with a relaxed fit. Pre-shrunk so it keeps its shape wash after wash.',
   array['100% cotton', 'Relaxed fit', 'Machine washable'],
   '[{"name":"Size","options":[{"label":"S"},{"label":"M"},{"label":"L"},{"label":"XL"}]},{"name":"Colour","options":[{"label":"White"},{"label":"Black"},{"label":"Olive"}]}]'::jsonb),
  ('runner-sneakers', 'Runner Pro Sneakers', 'Stride', 'fashion', 69.99, 94.99, 4.6, 1033, 16, 5, false, array['https://images.unsplash.com/photo-1542291026-7eec264c27ff'],
   'Lightweight running shoes with responsive foam cushioning and a breathable mesh upper.',
   array['Breathable mesh', 'Responsive foam midsole', 'Rubber grip outsole'],
   '[{"name":"Size (EU)","options":[{"label":"40"},{"label":"41"},{"label":"42"},{"label":"43"},{"label":"44"},{"label":"45"}]}]'::jsonb),
  ('biker-jacket', 'Leather Biker Jacket', 'Stride', 'fashion', 129, null, 4.5, 76, 7, 17, true, array['https://images.unsplash.com/photo-1551028719-00167b16eac5'],
   'A classic biker jacket in soft genuine leather with an asymmetric zip and quilted lining.',
   array['Genuine leather', 'Quilted lining', 'Three zip pockets'],
   '[{"name":"Size","options":[{"label":"S"},{"label":"M"},{"label":"L"},{"label":"XL"}]}]'::jsonb),
  ('sunglasses', 'Polarised Sunglasses', 'Heritage', 'fashion', 24.99, 34.99, 4.1, 259, 28, 18, false, array['https://images.unsplash.com/photo-1572635196237-14b3f281503f'],
   'UV400 polarised lenses cut glare on bright days. Lightweight frame with a protective case included.',
   array['UV400 protection', 'Polarised lenses', 'Case included'],
   '[]'::jsonb)
on conflict (id) do nothing;

-- 6. MAKE YOURSELF ADMIN -----------------------------------------------
-- Replace the email with the one you created under Authentication > Users.
insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('you@example.com')
on conflict do nothing;

-- Check it worked: this should return 1 row with your email.
select u.email from public.admins a join auth.users u on u.id = a.user_id;
