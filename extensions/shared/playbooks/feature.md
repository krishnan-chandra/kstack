# Feature proof obligations

A feature is complete when its promised observable behavior works for its intended user.

- **Planner:** turn the request into observable acceptance criteria, identify the affected user/API path and failure or empty states, and select the most realistic available verification surface.
- **Implementer:** exercise the real user/API path when practical, not only implementation details. Add focused automated coverage for the acceptance criteria and preserve relevant compatibility behavior.
- **Final evidence:** report each acceptance criterion, the check or real-surface observation that supports it, and any user path that could not be exercised.
