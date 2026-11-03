const DB_NAME = 'kornu-web-snapshots';
const VERSION = 1;

let connection;
function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}

async function operation(storeName, mode, method, ...args) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = transaction.objectStore(storeName)[method](...args);
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || request.error || new Error('Browser storage was interrupted.'));
  });
}

export const putSnapshot = (id, snapshot) => operation('snapshots', 'readwrite', 'put', snapshot, id);
export const getSnapshot = (id) => operation('snapshots', 'readonly', 'get', id);
export const getAllSnapshots = () => operation('snapshots', 'readonly', 'getAll');
export async function getAllSnapshotEntries() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('snapshots', 'readonly');
    const store = transaction.objectStore('snapshots');
    const keys = store.getAllKeys();
    const values = store.getAll();
    transaction.oncomplete = () => resolve(keys.result.map((key, index) => ({ key, snapshot: values.result[index] })));
    transaction.onerror = () => reject(transaction.error);
  });
}
export const putAsset = (key, blob) => operation('assets', 'readwrite', 'put', blob, key);
export const getAsset = (key) => operation('assets', 'readonly', 'get', key);

export async function getAllAssets() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('assets', 'readonly');
    const store = transaction.objectStore('assets');
    const keys = store.getAllKeys();
    const values = store.getAll();
    transaction.oncomplete = () => resolve(keys.result.map((key, index) => ({ key, blob: values.result[index] })));
    transaction.onerror = () => reject(transaction.error);
  });
}
