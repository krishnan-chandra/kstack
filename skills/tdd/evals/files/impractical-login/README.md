# staging-login

The login callback talks to a live corporate IdP and writes a session into
shared Redis. Cookie flags (`Secure`, `HttpOnly`, `Domain`) are applied by
the staging TLS terminator in a separate infra repo. This checkout only
builds the `sid=<id>` name/value pair.

There is no local IdP, Redis, or HTTPS listener. A unit test cannot observe
whether a real browser stores the cookie on `https://staging.example.com`.
