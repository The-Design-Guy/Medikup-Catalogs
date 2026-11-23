// Edit-mode backend (Vercel serverless function).
// The site's edit mode (?edit) POSTs here. Nothing on the live site changes:
// each request is committed to edits/<id>/ in the repo, and Claude reviews,
// converts images and applies it in a later session.
//
// Env vars (Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN   fine-grained token, this repo only, Contents: read & write
//   EDIT_PASSWORD  password for edit mode
//   GITHUB_REPO    "The-Design-Guy/Medikup-Catalogs"
//
// Body: { action:'auth', password }                      -> 200 | 401
//       { password, note, page, changes:[...], images:[{ name, data(base64) }] }
//                                                          -> 200 { id }

const crypto = require('crypto');

const MAX_TOTAL = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const MAX_IMAGES = 12;
const MAX_CHANGES = 200;
const IMG_NAME = /^img-\d{1,3}\.(webp|png|jpg)$/;
const BRANCH = 'main';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'medikup-edit-mode',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('github ' + r.status + ' ' + (j.message || '')); e.status = r.status; throw e; }
  return j;
}

// One commit with every file (Git Data API), retried once if main moved meanwhile.
async function commitFiles(files, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh('/git/ref/heads/' + BRANCH);
    const head = ref.object.sha;
    const base = await gh('/git/commits/' + head);
    const tree = [];
    for (const f of files) {
      const blob = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.base64, encoding: 'base64' }) });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
    const c = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
    try {
      await gh('/git/refs/heads/' + BRANCH, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
      return c.sha;
    } catch (e) {
      if (e.status !== 422 || attempt) throw e;
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { GITHUB_TOKEN, EDIT_PASSWORD, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !EDIT_PASSWORD || !GITHUB_REPO) return res.status(503).json({ error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_json' });

  if (!safeEq(body.password || '', EDIT_PASSWORD)) { await sleep(500); return res.status(401).json({ error: 'password' }); }
  if (body.action === 'auth') return res.status(200).json({ ok: true });

  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
  const images = Array.isArray(body.images) ? body.images : [];
  const note = String(body.note || '').slice(0, 5000);
  if (!changes.length && !note.trim()) return res.status(400).json({ error: 'empty' });
  if (images.length > MAX_IMAGES) return res.status(413).json({ error: 'too_many_images' });

  let total = 0;
  for (const im of images) {
    if (!im || !IMG_NAME.test(im.name || '') || typeof im.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return res.status(400).json({ error: 'bad_image' });
    total += im.data.length;
  }
  if (total > MAX_TOTAL) return res.status(413).json({ error: 'too_big' });

  const now = new Date();
  const id = now.toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
  const dir = 'edits/' + id + '/';
  const request = { id, created: now.toISOString(), status: 'pending', page: String(body.page || '').slice(0, 500), note, changes };
  const files = [{ path: dir + 'request.json', base64: Buffer.from(JSON.stringify(request, null, 2) + '\n').toString('base64') }]
    .concat(images.map(im => ({ path: dir + im.name, base64: im.data })));

  try {
    await commitFiles(files, 'edit request ' + id + ' (' + changes.length + ' changes, ' + images.length + ' images) — pending review');
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'github', detail: String(e.message || e).slice(0, 200) });
  }
  return res.status(200).json({ ok: true, id });
};
