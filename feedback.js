// Tester-Feedback aus der App als GitHub-Issue anlegen. Bilder und
// Diagnose-JSON landen als Dateien im Branch FEEDBACK_BRANCH des Repos
// (die Issues-API kann keine Anhänge) und werden im Issue verlinkt.
// Der Token (GITHUB_TOKEN, fine-grained: Issues + Contents schreiben auf
// genau dieses Repo) bleibt auf dem Server, nie in der App.

const REPO = process.env.FEEDBACK_REPO || 'JanOlfs/waage';
const BRANCH = process.env.FEEDBACK_BRANCH || 'feedback';
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // nach Base64-Dekodierung
const MAX_DIAGNOSTICS_CHARS = 2 * 1024 * 1024;
const RATE_LIMIT = 10; // Meldungen pro Stunde und IP
const recentByIp = new Map();

const KINDS = { bug: { label: 'bug', title: 'Fehler' }, feature: { label: 'enhancement', title: 'Wunsch' } };

class FeedbackError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new FeedbackError(413, 'Zu groß, bitte weniger oder kleinere Bilder.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rateLimited(ip) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (recentByIp.get(ip) ?? []).filter((t) => t > hourAgo);
  recent.push(Date.now());
  recentByIp.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Eingaben prüfen und auf das Nötige zuschneiden; wirft FeedbackError(400). */
function parseFeedback(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new FeedbackError(400, 'Ungültige Anfrage.');
  }
  const kind = KINDS[data?.kind] ? data.kind : null;
  const text = str(data?.text, 5000);
  if (!kind || !text) throw new FeedbackError(400, 'Art und Beschreibung fehlen.');
  const images = Array.isArray(data.images) ? data.images.slice(0, MAX_IMAGES) : [];
  const decoded = images.map((image) => {
    const match = typeof image === 'string' && image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new FeedbackError(400, 'Ungültiges Bild.');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) throw new FeedbackError(413, 'Ein Bild ist zu groß.');
    return { ext: match[1] === 'jpeg' ? 'jpg' : match[1], buffer };
  });
  const diagnostics = typeof data.diagnostics === 'string' ? data.diagnostics.slice(0, MAX_DIAGNOSTICS_CHARS) : '';
  const meta = Object.fromEntries(
    Object.entries(data.meta && typeof data.meta === 'object' ? data.meta : {})
      .slice(0, 10)
      .map(([key, value]) => [str(key, 40), str(String(value), 300)])
  );
  return { kind, text, name: str(data.name, 60), images: decoded, diagnostics, meta };
}

// Erwähnungen (@name) im Freitext würden Leute benachrichtigen: unschädlich machen.
const defuse = (text) => text.replace(/@/g, '@​');

function issueBody({ kind, text, name, meta }, links) {
  const lines = [
    `**${KINDS[kind].title}** gemeldet von ${name ? defuse(name) : 'anonym'}`,
    '',
    ...defuse(text).split('\n').map((line) => `> ${line}`),
    '',
  ];
  for (const link of links.images) lines.push(`![Bild](${link})`);
  if (links.diagnostics) lines.push(`Diagnose: [diagnose.json](${links.diagnostics})`);
  const metaRows = Object.entries(meta).map(([key, value]) => `| ${defuse(key)} | ${defuse(value).replace(/\|/g, '/')} |`);
  if (metaRows.length) lines.push('', '| | |', '|---|---|', ...metaRows);
  return lines.join('\n');
}

async function github(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'scaleroom-feedback',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createIssue(token, feedback) {
  const dir = `feedback/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const upload = async (file, buffer) => {
    const path = `${dir}/${file}`;
    // nacheinander, parallele Commits auf denselben Branch kollidieren
    await github(token, 'PUT', `/repos/${REPO}/contents/${path}`, {
      message: `Feedback-Anhang ${path}`,
      content: buffer.toString('base64'),
      branch: BRANCH,
    });
    return `https://github.com/${REPO}/blob/${BRANCH}/${path}?raw=true`;
  };
  const links = { images: [], diagnostics: '' };
  for (const [i, image] of feedback.images.entries()) {
    links.images.push(await upload(`bild-${i + 1}.${image.ext}`, image.buffer));
  }
  if (feedback.diagnostics) {
    links.diagnostics = await upload('diagnose.json', Buffer.from(feedback.diagnostics, 'utf8'));
  }
  const firstLine = feedback.text.split('\n')[0];
  const title = `[Tester] ${firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine}`;
  const issue = await github(token, 'POST', `/repos/${REPO}/issues`, {
    title,
    body: issueBody(feedback, links),
    labels: ['tester', KINDS[feedback.kind].label],
  });
  return { number: issue.number };
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}

/** HTTP-Handler für /feedback (POST, plus CORS-Preflight). */
async function handleFeedback(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new FeedbackError(503, 'Feedback ist auf dem Server nicht eingerichtet.');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim();
    if (rateLimited(ip)) throw new FeedbackError(429, 'Zu viele Meldungen, bitte später nochmal.');
    const feedback = parseFeedback(await readBody(req));
    const issue = await createIssue(token, feedback);
    console.log(`📝 Feedback #${issue.number} angelegt`);
    send(res, 201, issue);
  } catch (err) {
    if (err instanceof FeedbackError) {
      send(res, err.status, { message: err.message });
    } else {
      console.error('💥 Feedback fehlgeschlagen:', err.message);
      send(res, 502, { message: 'Konnte die Meldung nicht anlegen.' });
    }
  }
}

module.exports = { handleFeedback, parseFeedback, issueBody };
