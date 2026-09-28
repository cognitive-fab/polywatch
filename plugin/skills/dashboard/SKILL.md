---
name: dashboard
description: Open the polywatch dashboard for this project, a one-file HTML page showing reviews running now, questions waiting on the user with the default if they do nothing, the latest reviews, and anything stuck. Use when the user asks for the polywatch dashboard, wants to watch polywatch while Claude works on a long task, or asks what polywatch is doing.
---

# polywatch dashboard

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/polywatch.mjs" dashboard` from the project root. It writes `.polywatch/dashboard.html` and opens it in the browser. The page reloads itself every 10 seconds, and polywatch rewrites it whenever a review starts or ends, results are delivered, or an outcome is recorded.
2. Tell the user where the file is and that they can keep it open while working. Mention the style settings once: `"dashboard": { "theme": "light" | "dark" | "auto", "density": "compact" | "airy", "accent": "#1D56C9" }` in `~/.polywatch.json`. If they state a preference, write it there.
3. If the "Waiting on you" panel lists unrated findings that you fixed in this session, offer to record them: `node "${CLAUDE_PLUGIN_ROOT}/bin/polywatch.mjs" outcome <reviewId> <n> real|false "<note>"`.
