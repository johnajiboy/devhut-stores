/* Devhut Stores: shopper accounts (email + password, and Google) via Supabase Auth.
   Relies on `db` and `toast` from app.js. */
(function () {
  'use strict';
  if (typeof db === 'undefined' || !db) return;

  const $ = (sel) => document.querySelector(sel);
  const el = {
    dialog: $('#auth-dialog'), title: $('#auth-title'), close: $('#auth-close'),
    open: $('#account-button'), label: $('#account-label'),
    guest: $('#auth-guest'), user: $('#auth-user'),
    userName: $('#auth-user-name'), userEmail: $('#auth-user-email'), signOut: $('#signout-btn'),
    tabs: document.querySelectorAll('[data-auth-tab]'),
    form: $('#auth-form'), nameField: $('#auth-name-field'), name: $('#auth-name'),
    email: $('#auth-email'), password: $('#auth-password'), hint: $('#auth-password-hint'),
    message: $('#auth-message'), submit: $('#auth-submit'), google: $('#google-btn'),
  };

  let mode = 'signin';
  let user = null;

  const displayName = (u) => u?.user_metadata?.full_name || u?.user_metadata?.name || u?.email?.split('@')[0] || 'Account';

  function say(text, info = false) {
    el.message.textContent = text || '';
    el.message.hidden = !text;
    el.message.classList.toggle('is-info', info);
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.authTab === mode)));
    el.nameField.hidden = !signup;
    el.hint.hidden = !signup;
    el.password.autocomplete = signup ? 'new-password' : 'current-password';
    el.submit.textContent = signup ? 'Create account' : 'Sign in';
    el.title.textContent = signup ? 'Create your account' : 'Welcome back';
    say('');
  }

  function render() {
    const signedIn = Boolean(user);
    el.guest.hidden = signedIn;
    el.user.hidden = !signedIn;
    el.label.textContent = signedIn ? displayName(user).split(' ')[0] : 'Sign in';
    el.open.setAttribute('aria-label', signedIn ? `Account: ${displayName(user)}` : 'Sign in or create account');
    if (signedIn) {
      el.title.textContent = 'Your account';
      el.userName.textContent = displayName(user);
      el.userEmail.textContent = user.email || '';
    } else if (!el.dialog.open) {
      setMode('signin');
    }
    prefillCheckout();
  }

  /* Fill the checkout contact fields for signed-in shoppers (never overwrites typing) */
  function prefillCheckout() {
    if (!user) return;
    const fill = (id, value) => { const f = document.getElementById(id); if (f && !f.value && value) f.value = value; };
    fill('fullName', displayName(user) !== user.email?.split('@')[0] ? displayName(user) : '');
    fill('email', user.email);
  }

  const redirectUrl = () => location.origin + location.pathname;

  async function submit(event) {
    event.preventDefault();
    say('');
    const email = el.email.value.trim();
    const password = el.password.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say('Enter an email address like name@example.com.');
    if (mode === 'signup' && el.name.value.trim().length < 2) return say('Enter your full name.');
    if (password.length < 8) return say('Your password must be at least 8 characters.');

    el.submit.disabled = true;
    try {
      if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({
          email, password,
          options: { data: { full_name: el.name.value.trim() }, emailRedirectTo: redirectUrl() },
        });
        if (error) throw error;
        if (!data.session) {
          // Email confirmation is on (or the address already exists: Supabase hides which)
          say('Check your inbox: we sent a link to confirm your email. Then sign in.', true);
          return;
        }
        toast('Account created. Welcome!');
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast('Signed in');
      }
      el.form.reset();
      el.dialog.close();
    } catch (err) {
      say(/invalid login/i.test(err.message) ? 'Wrong email or password.'
        : /not confirmed/i.test(err.message) ? 'Please confirm your email first: check your inbox for the link.'
        : err.message || 'Something went wrong. Please try again.');
    } finally {
      el.submit.disabled = false;
    }
  }

  async function google() {
    say('');
    el.google.disabled = true;
    const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
    if (error) {
      el.google.disabled = false;
      say(/not enabled|unsupported provider/i.test(error.message)
        ? 'Google sign-in isn’t switched on for this store yet.' : error.message);
    }                                              // on success the browser leaves for Google
  }

  el.open.addEventListener('click', () => { say(''); render(); el.dialog.showModal(); });
  el.close.addEventListener('click', () => el.dialog.close());
  el.dialog.addEventListener('click', (e) => { if (e.target === el.dialog) el.dialog.close(); });  // backdrop click
  el.tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.authTab)));
  el.form.addEventListener('submit', submit);
  el.google.addEventListener('click', google);
  el.signOut.addEventListener('click', async () => {
    await db.auth.signOut();
    el.dialog.close();
    toast('Signed out');
  });

  db.auth.onAuthStateChange((event, session) => {
    user = session?.user ?? null;
    render();
    if (event === 'SIGNED_IN' && new URLSearchParams(location.search).has('code')) {
      history.replaceState(null, '', location.pathname + location.hash);   // drop ?code= after OAuth
    }
  });
  db.auth.getSession().then(({ data }) => { user = data.session?.user ?? null; render(); });
  // Checkout fields are created once, so refill whenever the checkout route opens
  window.addEventListener('hashchange', prefillCheckout);
})();
