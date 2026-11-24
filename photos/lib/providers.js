// The two backup destinations, behind one interface the backup engine uses:
//   account()                         → { name, email, used, total }
//   folder(path)                      → id of the folder at path (an array of names), created when missing
//   upload(parentId, blob, { name, mime, takenAt, photoId, onProgress }) → { id, name }
//   remove(id)                        → the cloud copy goes to the provider's recycle bin / trash
//   download(id)                      → Blob
//   list(folderId)                    → every media file under the folder: [{ id, name, size, mime, takenAt, photoId }]
// Both take { fetch, token(force) } so the tests can run them against a fake server.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GAPI = 'https://www.googleapis.com/drive/v3';
const GUPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SMALL = 4 * 1024 * 1024; // OneDrive's simple upload limit; bigger files go in an upload session
const CHUNK = 320 * 1024 * 16; // 5 MiB: OneDrive wants multiples of 320 KiB

export class CloudError extends Error {
  constructor(message, status = 0, code = '', retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const isMedia = (mime = '', name = '') => /^(image|video)\//.test(mime) || /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|m4v|webm)$/i.test(name);

/** fetch with the bearer token; on 401 the token is renewed once. Errors become CloudError. */
function client({ fetch: f = globalThis.fetch.bind(globalThis), token }) {
  return async function call(url, init = {}, { auth = true, raw = false, retry = true } = {}) {
    const headers = new Headers(init.headers || {});
    if (auth) headers.set('Authorization', `Bearer ${await token(false)}`);
    let res;
    try {
      res = await f(url, { ...init, headers });
    } catch {
      throw new CloudError('Can’t reach the cloud. Check your connection.', 0, 'offline');
    }
    if (res.status === 401 && auth && retry) {
      await token(true);
      return call(url, init, { auth, raw, retry: false });
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(60, Number(res.headers.get('Retry-After')) || 5);
      throw new CloudError('The cloud asked Photos to slow down.', res.status, 'throttled', wait);
    }
    if (!res.ok) {
      let msg = '';
      let code = '';
      try {
        const j = await res.json();
        msg = j.error?.message || j.error_description || '';
        code = j.error?.code || j.error?.errors?.[0]?.reason || '';
      } catch {}
      if (res.status === 507 || code === 'quotaLimitExceeded' || code === 'storageQuotaExceeded') throw new CloudError('Your cloud storage is full.', res.status, 'full');
      throw new CloudError(msg || `The cloud answered ${res.status}.`, res.status, code);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const type = res.headers.get('Content-Type') || '';
    return type.includes('json') ? res.json() : res;
  };
}

// ---------------------------------------------------------------- OneDrive (Microsoft Graph)

export function oneDrive(opts) {
  const call = client(opts);
  const f = opts.fetch || globalThis.fetch.bind(globalThis);
  const enc = (name) => encodeURIComponent(name).replace(/'/g, '%27');

  async function child(parentId, name) {
    try {
      return await call(`${GRAPH}/me/drive/items/${parentId}:/${enc(name)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  return {
    id: 'onedrive',
    async account() {
      const d = await call(`${GRAPH}/me/drive?$select=owner,quota`);
      const u = d.owner?.user || {};
      return { name: u.displayName || '', email: u.email || '', used: d.quota?.used ?? null, total: d.quota?.total ?? null };
    },
    /** path[0] lives in the Pictures folder (its name follows the account's language), like Samsung Gallery's. */
    async folder(path) {
      let parent = (await call(`${GRAPH}/me/drive/special/photos?$select=id`)).id;
      for (const name of path) {
        const found = await child(parent, name);
        if (found?.folder) parent = found.id;
        else {
          const made = await call(`${GRAPH}/me/drive/items/${parent}/children`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': found ? 'rename' : 'fail' }),
          }).catch(async (err) => {
            if (err.status === 409) return child(parent, name); // made by another tab a moment ago
            throw err;
          });
          parent = made.id;
        }
      }
      return parent;
    },
    async upload(parentId, blob, { name, mime, takenAt, onProgress } = {}) {
      const when = takenAt ? new Date(takenAt).toISOString() : null;
      if (blob.size <= SMALL) {
        const item = await call(`${GRAPH}/me/drive/items/${parentId}:/${enc(name)}:/content?@microsoft.graph.conflictBehavior=rename`, {
          method: 'PUT',
          headers: { 'Content-Type': mime || blob.type || 'application/octet-stream' },
          body: blob,
        });
        onProgress?.(blob.size);
        if (when) await call(`${GRAPH}/me/drive/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileSystemInfo: { createdDateTime: when, lastModifiedDateTime: when } }) }).catch(() => {});
        return { id: item.id, name: item.name };
      }
      const session = await call(`${GRAPH}/me/drive/items/${parentId}:/${enc(name)}:/createUploadSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', ...(when ? { fileSystemInfo: { createdDateTime: when, lastModifiedDateTime: when } } : {}) } }),
      });
      let item = null;
      for (let start = 0; start < blob.size; start += CHUNK) {
        const end = Math.min(blob.size, start + CHUNK);
        // The upload URL carries its own authorization: no bearer token (Graph refuses one there).
        let res;
        try {
          res = await f(session.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` }, body: blob.slice(start, end) });
        } catch {
          throw new CloudError('Can’t reach the cloud. Check your connection.', 0, 'offline');
        }
        if (!res.ok && res.status !== 202) {
          f(session.uploadUrl, { method: 'DELETE' }).catch(() => {});
          throw new CloudError(`OneDrive stopped the upload (${res.status}).`, res.status);
        }
        onProgress?.(end);
        if (res.status === 200 || res.status === 201) item = await res.json();
      }
      if (!item?.id) throw new CloudError('OneDrive didn’t confirm the upload.');
      return { id: item.id, name: item.name };
    },
    async remove(id) {
      try {
        await call(`${GRAPH}/me/drive/items/${id}`, { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404) throw err; // already gone is fine
      }
    },
    async download(id) {
      // The pre-authenticated download URL allows cross-origin reads; /content's redirect does not.
      const meta = await call(`${GRAPH}/me/drive/items/${id}?$select=id,@microsoft.graph.downloadUrl`);
      const url = meta['@microsoft.graph.downloadUrl'];
      if (!url) throw new CloudError('OneDrive didn’t give a download link.');
      const res = await f(url);
      if (!res.ok) throw new CloudError(`OneDrive download failed (${res.status}).`, res.status);
      return res.blob();
    },
    async list(folderId) {
      const out = [];
      const walk = async (id, depth) => {
        let url = `${GRAPH}/me/drive/items/${id}/children?$top=200&$select=id,name,size,file,folder,photo,video,fileSystemInfo`;
        while (url) {
          const page = await call(url);
          for (const it of page.value || []) {
            if (it.folder && depth < 3) await walk(it.id, depth + 1);
            else if (it.file && isMedia(it.file.mimeType, it.name)) {
              const taken = Date.parse(it.photo?.takenDateTime || it.fileSystemInfo?.createdDateTime || '');
              out.push({ id: it.id, name: it.name, size: it.size || 0, mime: it.file.mimeType || '', takenAt: Number.isFinite(taken) ? taken : null, photoId: null });
            }
          }
          url = page['@odata.nextLink'] || null;
        }
      };
      await walk(folderId, 0);
      return out;
    },
  };
}

// ---------------------------------------------------------------- Google Drive

export function googleDrive(opts) {
  const call = client(opts);
  const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return {
    id: 'gdrive',
    async account() {
      const a = await call(`${GAPI}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)`);
      const lim = Number(a.storageQuota?.limit);
      return { name: a.user?.displayName || '', email: a.user?.emailAddress || '', used: Number(a.storageQuota?.usage) || 0, total: Number.isFinite(lim) && lim > 0 ? lim : null };
    },
    /** path[0] lives at the top of My Drive. With drive.file Photos only ever sees folders it made itself. */
    async folder(path) {
      let parent = 'root';
      for (const name of path) {
        const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${q(parent)}' in parents and trashed = false`;
        const found = await call(`${GAPI}/files?${new URLSearchParams({ q: query, fields: 'files(id,name)', spaces: 'drive', pageSize: '1' })}`);
        if (found.files?.[0]) parent = found.files[0].id;
        else {
          const made = await call(`${GAPI}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }) });
          parent = made.id;
        }
      }
      return parent;
    },
    async upload(parentId, blob, { name, mime, takenAt, photoId, onProgress } = {}) {
      const meta = {
        name,
        parents: [parentId],
        mimeType: mime || blob.type || 'application/octet-stream',
        appProperties: { ecosysPhotoId: String(photoId || ''), takenAt: takenAt ? String(takenAt) : '' },
        ...(takenAt ? { modifiedTime: new Date(takenAt).toISOString() } : {}),
      };
      if (blob.size > 5 * 1024 * 1024) {
        // Drive's resumable protocol for big files (videos): open a session, then send the file to it.
        const start = await call(`${GUPLOAD}/files?uploadType=resumable&fields=id,name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType, 'X-Upload-Content-Length': String(blob.size) },
          body: JSON.stringify(meta),
        }, { raw: true });
        const session = start.headers.get('Location');
        if (!session) throw new CloudError('Google Drive didn’t open an upload.');
        const item = await call(session, { method: 'PUT', headers: { 'Content-Type': meta.mimeType }, body: blob });
        onProgress?.(blob.size);
        return { id: item.id, name: item.name };
      }
      // Small files: one multipart request, metadata and file together.
      const boundary = `ecosys${Math.random().toString(36).slice(2)}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ]);
      const item = await call(`${GUPLOAD}/files?uploadType=multipart&fields=id,name`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
      onProgress?.(blob.size);
      return { id: item.id, name: item.name };
    },
    async remove(id) {
      try {
        await call(`${GAPI}/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    },
    async download(id) {
      const res = await call(`${GAPI}/files/${id}?alt=media`, {}, { raw: true });
      return res.blob();
    },
    async list(folderId) {
      const out = [];
      const walk = async (id, depth) => {
        let pageToken = '';
        do {
          const p = new URLSearchParams({ q: `'${q(id)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,size,mimeType,appProperties,imageMediaMetadata(time),createdTime)', pageSize: '1000', spaces: 'drive' });
          if (pageToken) p.set('pageToken', pageToken);
          const page = await call(`${GAPI}/files?${p}`);
          for (const it of page.files || []) {
            if (it.mimeType === FOLDER_MIME) {
              if (depth < 3) await walk(it.id, depth + 1);
            } else if (isMedia(it.mimeType, it.name)) {
              const fromApp = Number(it.appProperties?.takenAt);
              const created = Date.parse(it.createdTime || '');
              out.push({ id: it.id, name: it.name, size: Number(it.size) || 0, mime: it.mimeType || '', takenAt: fromApp || (Number.isFinite(created) ? created : null), photoId: it.appProperties?.ecosysPhotoId || null });
            }
          }
          pageToken = page.nextPageToken || '';
        } while (pageToken);
      };
      await walk(folderId, 0);
      return out;
    },
  };
}

export function makeProvider(id, opts) {
  if (id === 'onedrive') return oneDrive(opts);
  if (id === 'gdrive') return googleDrive(opts);
  throw new Error(`Unknown provider ${id}`);
}
