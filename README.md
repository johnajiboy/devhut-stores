# Devhut Stores

A one-page e-commerce marketplace built with plain HTML, CSS and JavaScript: no
frameworks and no build step. Products, orders and admin login are handled by
Supabase; the site is hosted as static files on Vercel.

**Store:** product grid, search, category and price filters, sorting, product
pages with image gallery and options, cart drawer, wishlist, checkout and order
confirmation. Dark mode, keyboard support and mobile-first layout from 320px.

**Admin (`/admin.html`):** email and password sign-in, add / edit / delete
products, photo upload, stock and visibility control, product options, and an
order list with status updates.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Storefront markup and icon sprite |
| `styles.css` | All store styles (CSS variables, light and dark themes) |
| `app.js` | Store logic: state, rendering, routing, cart, checkout |
| `admin.html` | Admin page markup |
| `admin.css` | Admin-only styles |
| `admin.js` | Admin logic: auth, product CRUD, uploads, orders |
| `config.js` | Your Supabase URL and anon key |
| `setup.sql` | Database tables, security rules, order function, sample data |

## Setup

1. Create a project at [supabase.com](https://supabase.com).
2. In **Authentication > Users**, add a user with your admin email and password
   (tick *Auto Confirm User*). In **Authentication > Sign In / Providers**,
   switch off *Allow new users to sign up*.
3. Open `setup.sql`, replace `you@example.com` in section 6 with that email,
   then paste the whole file into **SQL Editor > New query** and run it.
4. Copy the Project URL and anon public key from **Project Settings > API**
   into `config.js`.
5. Run locally: `python3 -m http.server 5500`, then open
   <http://localhost:5500> and <http://localhost:5500/admin.html>.
6. Deploy: `npx vercel --prod`.

The anon key is safe to commit: it only allows what the database security rules
permit. Never commit the `service_role` key.

## How it works

- The store reads products and categories directly from Supabase.
- Checkout calls the `place_order` database function, which re-checks prices,
  option costs and stock on the server, reduces stock and saves the order, so
  totals can't be tampered with in the browser.
- Row Level Security limits writes to accounts listed in the `admins` table.
  Shoppers can read active products only and cannot read orders.
- Cart, wishlist and theme are stored in the browser with `localStorage`.
- All dynamic text is written with `textContent`, never `innerHTML`.

## Notes

- Payment is simulated. Card details are validated in the browser and never
  sent anywhere. Add Paystack, Flutterwave or Stripe for real payments.
- Free Supabase projects pause after 7 days of inactivity; restore them from
  the dashboard.
