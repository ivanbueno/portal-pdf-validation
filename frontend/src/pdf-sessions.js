// Two operations at a time also bound the number of pinned document sessions.
// Idle sessions are evicted in least-recently-used order before loading another.
export function documentSessions(open, limit = 2) {
  const sessions = new Map();
  const waiting = [];
  let active = 0;

  function drain() {
    while (active < limit && waiting.length) {
      const waiter = waiting.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      active++;
      waiter.resolve();
    }
  }

  function enter(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        abort: () => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      waiting.push(waiter);
      drain();
    });
  }

  async function discard(key, entry) {
    if (sessions.get(key) === entry) sessions.delete(key);
    await entry.close();
  }

  return async function withDocument(key, signal, use) {
    await enter(signal);
    let entry;
    try {
      signal.throwIfAborted();
      entry = sessions.get(key);
      if (!entry) {
        while (!entry && sessions.size >= limit) {
          const [oldKey, old] = [...sessions].find(([, item]) => !item.users);
          await discard(oldKey, old);
          signal.throwIfAborted();
          // Another operation may have loaded this document during disposal.
          entry = sessions.get(key);
        }
        if (!entry) {
          entry = { ...open(key), users: 0, loaded: false };
          sessions.set(key, entry);
          const opened = entry;
          entry.ready.then(
            () => {
              opened.loaded = true;
            },
            () => {},
          );
        }
      }
      entry.users++;
      sessions.delete(key);
      sessions.set(key, entry);
      // An abandoned download must not occupy a slot until the network finishes.
      let abort;
      try {
        const source = await Promise.race([
          entry.ready,
          new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
        return await use(source);
      } finally {
        signal.removeEventListener("abort", abort);
        entry.users--;
        if (!entry.users && (!entry.loaded || signal.aborted))
          await discard(key, entry);
      }
    } finally {
      active--;
      drain();
    }
  };
}
