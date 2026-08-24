import type { SubcontractorWithCompany } from './db';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

/**
 * The subcontractor's whole experience. One page, no account, no framework.
 * The requirements are stated up front because a sub who reads them before
 * uploading is a sub who does not end up in the review queue.
 */
export function renderUploadPage(sub: SubcontractorWithCompany): string {
  const co = sub.companies;
  const endorsements = [
    co.require_additional_insured ? 'Additional insured' : null,
    co.require_waiver_subrogation ? 'Waiver of subrogation' : null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Send your certificate of insurance — ${escape(co.company_name)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #fff; --ink: #14171c; --muted: #5b6472;
    --line: #dfe3e9; --accent: #1c5cd6; --ok: #0f7b46; --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12151a; --card:#1a1f27; --ink:#e9edf3; --muted:#9aa5b4;
            --line:#2a323d; --accent:#6f9cf5; --ok:#4ec98a; --bad:#f2907f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
         display:flex; justify-content:center; padding:32px 20px; }
  main { width:100%; max-width:560px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line);
          border-radius:12px; padding:24px; }
  .reqs { margin:0 0 20px; padding:16px; background:var(--bg);
          border-radius:8px; font-size:.9rem; }
  .reqs h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:.06em;
             color:var(--muted); margin:0 0 10px; }
  .reqs ul { margin:0; padding-left:18px; } .reqs li { margin:3px 0; }
  #drop { border:2px dashed var(--line); border-radius:10px; padding:36px 20px;
          text-align:center; cursor:pointer; transition:border-color .15s,background .15s; }
  #drop:hover, #drop.over { border-color:var(--accent); background:rgba(28,92,214,.04); }
  #drop p { margin:6px 0; } #drop .hint { color:var(--muted); font-size:.85rem; }
  input[type=file] { display:none; }
  #status { margin-top:18px; padding:14px 16px; border-radius:8px;
            border:1px solid var(--line); display:none; }
  #status.show { display:block; }
  #status.ok { border-color:var(--ok); } #status.bad { border-color:var(--bad); }
  #status h3 { margin:0 0 6px; font-size:.95rem; }
  #status ul { margin:8px 0 0; padding-left:18px; font-size:.9rem; color:var(--muted); }
  footer { margin-top:20px; text-align:center; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
<main>
  <h1>Certificate of insurance</h1>
  <p class="sub">${escape(sub.vendor_name)} → ${escape(co.company_name)}</p>

  <div class="card">
    <div class="reqs">
      <h2>What ${escape(co.company_name)} requires</h2>
      <ul>
        <li>General liability, each occurrence: <strong>${money(co.min_gl_each_occurrence)}</strong> minimum</li>
        <li>General aggregate: <strong>${money(co.min_gl_aggregate)}</strong> minimum</li>
        ${endorsements.map((e) => `<li>${escape(e)}</li>`).join('\n        ')}
        <li>Policy must not be expired</li>
      </ul>
    </div>

    <div id="drop" tabindex="0" role="button" aria-label="Choose a certificate to upload">
      <p><strong>Drop your ACORD 25 here</strong></p>
      <p class="hint">or click to choose a file — PDF, JPG or PNG, up to 15 MB</p>
    </div>
    <input type="file" id="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">

    <div id="status" role="status" aria-live="polite"></div>
  </div>

  <footer>You will see the result on this page in about 20 seconds.</footer>
</main>

<script>
const drop = document.getElementById('drop');
const input = document.getElementById('file');
const status = document.getElementById('status');
let busy = false;

const show = (cls, title, lines) => {
  status.className = 'show ' + (cls || '');
  status.innerHTML = '<h3>' + title + '</h3>' +
    (lines && lines.length ? '<ul>' + lines.map(l => '<li>' + l + '</li>').join('') + '</ul>' : '');
};

drop.addEventListener('click', () => !busy && input.click());
drop.addEventListener('keydown', e => {
  if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.click(); }
});
['dragenter','dragover'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave','drop'].forEach(t => drop.addEventListener(t, e => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', e => {
  if (!busy && e.dataTransfer.files.length) send(e.dataTransfer.files[0]);
});
input.addEventListener('change', () => input.files.length && send(input.files[0]));

async function send(file) {
  if (file.size > 15 * 1024 * 1024) {
    return show('bad', 'That file is too large', ['The limit is 15 MB.']);
  }
  busy = true;
  show('', 'Uploading ' + file.name + '…');
  const body = new FormData();
  body.append('file', file);

  try {
    const res = await fetch(location.pathname, { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) { busy = false; return show('bad', data.message || 'Upload failed', data.reasons); }
    show('', 'Reading your certificate…');
    poll(data.certificate_id, 0);
  } catch (err) {
    busy = false;
    show('bad', 'Upload failed', ['Check your connection and try again.']);
  }
}

async function poll(id, tries) {
  if (tries > 40) {
    busy = false;
    return show('', 'Still working on it',
      ['We have your file. Someone will follow up if anything is missing.']);
  }
  await new Promise(r => setTimeout(r, 1500));
  const res = await fetch(location.pathname + '/status/' + id);
  const data = await res.json();

  if (data.status === 'processing') return poll(id, tries + 1);
  busy = false;
  if (data.status === 'auto_approved') {
    show('ok', 'Approved — you are all set',
      data.expiration_date ? ['On file through ' + data.expiration_date + '.'] : []);
  } else {
    show('bad', 'We could not accept this certificate yet',
      (data.reasons || []).concat(['Ask your agent to send a corrected certificate, then upload it here.']));
  }
}
</script>
</body>
</html>`;
}
