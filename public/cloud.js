import { cloudConfig } from './config.js';
import { createClient } from './vendor/supabase-client.js';

const configured = Boolean(cloudConfig.url && cloudConfig.key);
const client = configured ? createClient(cloudConfig.url, cloudConfig.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
}) : null;

function requireClient() {
  if (!client) throw new Error('Kornu account storage has not been configured yet.');
  return client;
}

function assetPath(userID, assetKey) {
  const match = /^([a-f0-9-]{36}):image:(\d+)$/.exec(assetKey);
  if (!match) throw new Error('This image has an invalid storage key.');
  return `${userID}/${match[1]}/${match[2]}`;
}
function bookPath(userID, readingID) {
  if (!/^[a-f0-9-]{36}$/i.test(readingID)) throw new Error('This book has an invalid storage key.');
  return `${userID}/${readingID}/book`;
}

export const cloud = {
  configured,
  async session() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  onAuthChange(callback) {
    if (!client) return;
    return client.auth.onAuthStateChange((event, session) => {
      if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) queueMicrotask(() => callback(session?.user || null));
    });
  },
  async signIn() {
    const { error } = await requireClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname }
    });
    if (error) throw error;
  },
  async signOut() {
    const { error } = await requireClient().auth.signOut({ scope: 'local' });
    if (error) throw error;
  },
  async readings() {
    const rows = [];
    for (let start = 0;; start += 500) {
      const { data, error } = await requireClient().from('kornu_readings')
        .select('reading_id,data,updated_at').order('updated_at', { ascending: true }).range(start, start + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  },
  async saveReading(userID, readingID, data) {
    const { error } = await requireClient().from('kornu_readings').upsert(
      { user_id: userID, reading_id: readingID, data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,reading_id' }
    );
    if (error) throw error;
  },
  async uploadAsset(userID, assetKey, blob) {
    const { error } = await requireClient().storage.from('kornu-assets').upload(assetPath(userID, assetKey), blob, {
      upsert: true, contentType: blob.type || 'application/octet-stream'
    });
    if (error) throw error;
  },
  async downloadAsset(userID, assetKey) {
    const { data, error } = await requireClient().storage.from('kornu-assets').download(assetPath(userID, assetKey));
    if (error) throw error;
    return data;
  },
  async uploadBook(userID, readingID, blob) {
    const { error } = await requireClient().storage.from('kornu-assets').upload(bookPath(userID, readingID), blob, {
      upsert: true, contentType: blob.type || 'application/octet-stream'
    });
    if (error) throw error;
  },
  async downloadBook(userID, readingID) {
    const { data, error } = await requireClient().storage.from('kornu-assets').download(bookPath(userID, readingID));
    if (error) throw error;
    return data;
  }
};
