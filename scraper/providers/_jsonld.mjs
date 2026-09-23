// @ts-check
// Shared schema.org JSON-LD reader for provider payloads and job pages.
// Files prefixed with _ are never loaded as providers by scan.mjs.
//
// Two callers need the same thing — "every JSON-LD node on this page,
// whatever shape the site wrapped it in": icims.mjs (datePosted / location
// from the detail page) and full-description.mjs (the JobPosting body from
// Reed's public page, Adzuna's details page or an employer's own page). One
// copy, so a new wrapping shape is handled for both at once.

const LD_SCRIPT_RE = /<script\b[^>]*(?<![\w-])type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Every JSON-LD node in `html`, flattened: a bare object, an array of nodes,
 * or a graph document ({"@graph": [...]}) all become one flat list. Unparsable
 * blocks are skipped. `type` is not reliably the first attribute (CSP nonces
 * come first on some tenants), hence the lookbehind-anchored `type=` match.
 * @param {unknown} html
 * @returns {any[]}
 */
export function jsonLdNodes(html) {
  /** @type {any[]} */
  const nodes = [];
  if (typeof html !== 'string' || !html) return nodes;
  for (const [, raw] of html.matchAll(LD_SCRIPT_RE)) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (Array.isArray(data)) nodes.push(...data);
    else if (data && Array.isArray(data['@graph'])) nodes.push(...data['@graph']);
    else if (data) nodes.push(data);
  }
  return nodes;
}

/** @param {any} node */
export function isJobPosting(node) {
  if (!node || typeof node !== 'object') return false;
  const type = node['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
}

/**
 * The `description` (HTML or text, as the site wrote it) of the first
 * JobPosting node in `html`, or '' when there is none.
 * @param {unknown} html
 * @returns {string}
 */
export function jobPostingDescription(html) {
  for (const node of jsonLdNodes(html)) {
    if (isJobPosting(node) && typeof node.description === 'string' && node.description.trim()) return node.description;
  }
  return '';
}
