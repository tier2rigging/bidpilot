// TEST ONLY: can a Cloudflare Worker reach DLA's PUB LOG files? Only dla.mil PUB LOG zips, only with the key.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.headers.get('X-Relay-Key') !== env.RELAY_KEY) return new Response('no', { status: 403 });
    const f = u.searchParams.get('f') || '';
    if (!/^[A-Z_-]+\.(zip|pdf)$|^[A-Za-z -]+Layout\.pdf$/.test(f)) return new Response('bad file', { status: 400 });
    const r = await fetch(`https://www.dla.mil/Portals/104/Documents/InformationOperations/LogisticsInformationServices/FOIA/PUBLOG/${encodeURIComponent(f).replace(/%20/g, '%20')}`, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: '*/*' },
    });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'X-Upstream-Length': r.headers.get('content-length') || '', 'X-Upstream-Modified': r.headers.get('last-modified') || '' } });
  },
};
