// One bounded page per collection per tick, including when cached tasks are terminal.
// Never replace a newer local/detail read with an older in-flight list response.
export function createWorkspaceSummaryRefresh({ read, getContext, getItems, applyItems, collections = ['tasks', 'outputs'], pageSize = 100 }) {
  let busy = false;
  let context = null;
  const pages = new Map();
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
  return async function refresh() {
    const captured = getContext();
    if (!captured?.[0] || busy) return false;
    if (!same(context, captured)) { pages.clear(); context = captured; }
    busy = true;
    try {
      const results = await Promise.allSettled(collections.map(async key => {
        const pageState = pages.get(key) || { cursor: null, seen: new Set() };
        const original = new Map(getItems(key).map(item => [item.id, item]));
        const page = await read(key, { limit: pageSize, cursor: pageState.cursor });
        if (!same(captured, getContext())) return;
        const incoming = new Map((page[key] || []).map(item => [item.id, item]));
        const current = getItems(key);
        const known = new Set(current.map(item => item.id));
        const merged = current.map(item => incoming.has(item.id) && original.get(item.id) === item ? incoming.get(item.id) : item);
        for (const [id, item] of incoming) if (!known.has(id) && !original.has(id)) merged.push(item);
        applyItems(key, merged);
        const cursor = page.nextCursor || null;
        if (cursor && (cursor === pageState.cursor || pageState.seen.has(cursor))) {
          pages.delete(key);
          throw Error(`Pagination cursor repeated for ${key}`);
        }
        if (cursor) { pageState.cursor = cursor; pageState.seen.add(cursor); pages.set(key, pageState); }
        else pages.delete(key);
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return same(captured, getContext());
    } finally { busy = false; }
  };
}
