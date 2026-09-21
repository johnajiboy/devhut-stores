# Devhut Stores

A lightweight e-commerce storefront built with plain HTML, CSS and JavaScript —
no frameworks, no build step. Product data, orders and admin authentication
are powered by [Supabase](https://supabase.com), with the site hosted as
static files on [Vercel](https://vercel.com).

## Features

- Product grid with search, filters and sorting, product pages with image
  galleries and options, cart, wishlist, checkout and order confirmation
- Dark mode, keyboard support and a mobile-first layout
- Shopper accounts: email + password sign-up/sign-in, plus "Continue with Google"
- Admin panel (`/admin.html`) for managing products, stock and orders

## Setup notes

- Run `setup.sql`, then `seed_products.sql` (the extra catalogue: every category ends up with 50+ products).
- **Google sign-in**: create an OAuth client in Google Cloud Console (type *Web application*) with the
  authorised redirect URI `https://<your-project>.supabase.co/auth/v1/callback`. In Supabase go to
  Authentication > Providers > Google, enable it and paste the client ID and secret. Then add your site
  URL (and `http://localhost:*` for testing) under Authentication > URL Configuration > Redirect URLs.
- Email sign-up follows your Supabase setting for *Confirm email* (Authentication > Providers > Email).

## Notes

Payment is simulated for demonstration purposes. Integrate a provider such as
Stripe, Paystack or Flutterwave for real transactions.
