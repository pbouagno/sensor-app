/*
  db.js — saving recordings in the browser's built-in database (IndexedDB).

  Two "tables" (object stores):
  - sessions: one row per recording (start/end time, sample counts, device info)
  - chunks:   the raw readings, saved in small batches every couple of seconds
              so a long recording never has to sit in memory all at once.
*/
(function () {
  "use strict";
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB is not available in this browser"));
      const req = indexedDB.open("telematics", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        const chunks = db.createObjectStore("chunks", { autoIncrement: true });
        chunks.createIndex("session", "session");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // Run one transaction and wait for it to finish.
  async function tx(stores, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(work(t)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const DB = {
    saveSession: (s) => tx("sessions", "readwrite", (t) => { t.objectStore("sessions").put(s); }),
    addChunk: (session, rows) => tx("chunks", "readwrite", (t) => { t.objectStore("chunks").add({ session, rows }); }),
    listSessions: () => tx("sessions", "readonly", (t) => reqP(t.objectStore("sessions").getAll()))
      .then((list) => list.sort((a, b) => b.start - a.start)),
    getSession: (id) => tx("sessions", "readonly", (t) => reqP(t.objectStore("sessions").get(id))),
    // All raw rows of one session, in recording order: [streamId, t, ...values]
    getRows: (id) => tx("chunks", "readonly", (t) => reqP(t.objectStore("chunks").index("session").getAll(id)))
      .then((chunks) => chunks.flatMap((c) => c.rows)),
    deleteSession: (id) => tx(["sessions", "chunks"], "readwrite", (t) => {
      t.objectStore("sessions").delete(id);
      const idx = t.objectStore("chunks").index("session");
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { t.objectStore("chunks").delete(c.primaryKey); c.continue(); }
      };
    }),
    clearAll: () => tx(["sessions", "chunks"], "readwrite", (t) => {
      t.objectStore("sessions").clear(); t.objectStore("chunks").clear();
    }),
  };
  window.DB = DB;
})();
