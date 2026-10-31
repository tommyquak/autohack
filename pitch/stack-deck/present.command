#!/bin/zsh
# Double-click to present the Conjunction Triage Stack deck offline: serves this folder on port 4173 and opens it.
# In the page: press P (or the Present button) for the audience tab; this tab becomes the presenter view.
cd "${0:A:h}"
PORT=${PORT:-4173}
# Opens the browser on the first free port from $PORT (another copy of the deck may hold 4173).
DECK_OPEN=1 exec node tools/serve.mjs $PORT
