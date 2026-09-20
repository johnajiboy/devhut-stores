# Devhut Stores

A lightweight e-commerce storefront built with plain HTML, CSS and JavaScript —
no frameworks, no build step. Product data, orders and admin authentication
are powered by [Supabase](https://supabase.com), with the site hosted as
static files on [Vercel](https://vercel.com).

## Features

- Product grid with search, filters and sorting, product pages with image
  galleries and options, cart, wishlist, checkout and order confirmation
- Dark mode, keyboard support and a mobile-first layout
- Admin panel (`/admin.html`) for managing products, stock and orders

## Getting Started

1. Create a project at [supabase.com](https://supabase.com), add an admin
   user under **Authentication → Users**, and disable public sign-ups.
2. Run `setup.sql` in the Supabase SQL Editor to create the required tables,
   security rules and functions.
3. Add your Supabase project URL and anon key to `config.js`.
4. Serve the files locally (e.g. `python3 -m http.server 5500`) or deploy to
   Vercel.

## Security

- The anon key is safe to expose publicly; database access is governed by
  Row Level Security policies. Never expose the `service_role` key.
- Order totals are recalculated server-side to prevent tampering.
- Admin access is restricted to accounts listed in the `admins` table.

## Notes

Payment is simulated for demonstration purposes. Integrate a provider such as
Stripe, Paystack or Flutterwave for real transactions.
