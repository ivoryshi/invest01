export async function request(server, url, { method = 'GET', body: requestBody } = {}) {
  if (typeof server.dispatch === 'function') {
    const response = await server.dispatch({ method, url, body: requestBody });
    const responseBody = Buffer.isBuffer(response.body) ? response.body : Buffer.from(String(response.body ?? ''));
    const headers = new Map(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
    return {
      status: response.status,
      headers,
      text: () => responseBody.toString('utf8'),
      json: () => JSON.parse(responseBody.toString('utf8')),
      bytes: () => responseBody,
    };
  }
  const handler = server.listeners('request')[0];
  const headers = new Map();
  let status = 200;
  let body = Buffer.alloc(0);
  const req = { method, url };
  const res = {
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    writeHead(code, values = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), String(value));
    },
    end(value) {
      if (value !== undefined) body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    },
  };
  await handler(req, res);
  return {
    status,
    headers,
    text: () => body.toString('utf8'),
    json: () => JSON.parse(body.toString('utf8')),
    bytes: () => body,
  };
}
