'use strict';

/**
 * Deploy the working tree to Vercel without a git link.
 *
 * Used once, to get the project live before the GitHub App is granted access to
 * the repo. Inlines every text file into the deployment payload (the project is
 * ~280 KB, well under the limit) and lets vercel.json supply the routing table.
 *
 *   VERCEL_TOKEN=... node scripts/deploy-vercel.js
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT = process.env.VERCEL_PROJECT || 'hydra-addon';
const SKIP = new Set(['.git', 'node_modules', '.workbuddy-ai', '.vercel', '.wrangler']);

if (!TOKEN) {
  console.error('VERCEL_TOKEN is required');
  process.exit(1);
}

function collect(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, acc);
      continue;
    }
    const rel = path.relative('.', full).split(path.sep).join('/');
    if (/\.(mp4|png|jpg|jpeg|zip|log)$/i.test(rel)) continue;
    acc.push({ file: rel, data: fs.readFileSync(full, 'utf8') });
  }
  return acc;
}

(async () => {
  const files = collect('.');
  const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.data), 0);
  console.log(`packing ${files.length} files (${Math.round(bytes / 1024)} KB)`);

  const res = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      target: 'production',
      files,
    }),
  });

  const body = await res.json();
  if (body.error) {
    console.error('deploy failed:', body.error.code, body.error.message);
    process.exit(1);
  }

  console.log('deployment id:', body.id);
  console.log('url:', body.url);

  // Poll until the build settles so the caller knows whether it actually worked.
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`https://api.vercel.com/v13/deployments/${body.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const d = await check.json();
    if (d.readyState === 'READY') {
      console.log('READY ->', d.url);
      return;
    }
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED') {
      console.error('build ended in', d.readyState);
      process.exit(1);
    }
    process.stdout.write(`  ${d.readyState}… `);
  }
  console.error('timed out waiting for the build');
  process.exit(1);
})();
