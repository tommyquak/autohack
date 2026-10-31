// Thin client for the dashboard API (docs/CONTRACT.md §4). A 503 carries the command that builds the missing report.
async function get(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`Cannot reach the server (${url}). Is it running?`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail || "";
    } catch {
      /* not JSON */
    }
    throw new Error(`${url} -> ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

const details = new Map();

export const api = {
  summary: () => get("/api/summary"),
  events: () => get("/api/events"),
  metrics: () => get("/api/metrics"),
  async event(id) {
    if (!details.has(id)) details.set(id, get(`/api/events/${id}`).catch((e) => (details.delete(id), Promise.reject(e))));
    return details.get(id);
  },
  explain: (id, llm) => get(`/api/explain/${id}?llm=${llm ? "true" : "false"}`),
};
