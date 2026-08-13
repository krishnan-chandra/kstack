Repro (staging only):

1. Connect to the corp VPN.
2. Sign in at https://staging.example.com/login through Okta.
3. After redirect, DevTools → Application → Cookies should show `sid` with
   Secure and HttpOnly.
4. Today `sid` is missing after the callback, so /app 302s back to /login.

Local `node --test` cannot exercise this path.
