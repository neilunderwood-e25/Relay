import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = resolve(REPO_ROOT, 'website');

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.atom', 'application/atom+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2']
]);

function isInside(root, target) {
  const difference = relative(root, target);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

function decodedPathname(rawUrl) {
  const rawPathname = rawUrl.split(/[?#]/, 1)[0];
  let decoded = rawPathname;

  // Decode more than once so double-encoded traversal cannot become meaningful
  // to a downstream filesystem or proxy layer.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }

  return decoded.replaceAll('\\', '/');
}

function send(request, response, status, body, headers = {}) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'Content-Length': payload.byteLength,
    ...headers
  });
  response.end(request.method === 'HEAD' ? undefined : payload);
}

function sendNotFound(request, response) {
  send(request, response, 404, '<!doctype html><title>Not found</title><h1>404 Not Found</h1>', {
    'Content-Type': 'text/html; charset=utf-8'
  });
}

/**
 * Start a static-site preview server.
 *
 * @param {{ root?: string, port?: number, host?: string }} [options]
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export async function startSiteServer({ root = DEFAULT_ROOT, port = 4173, host = '127.0.0.1' } = {}) {
  const rootPath = resolve(root);
  const rootInfo = await stat(rootPath);
  if (!rootInfo.isDirectory()) {
    const error = new Error(`Site root is not a directory: ${rootPath}`);
    error.code = 'ENOTDIR';
    throw error;
  }
  const canonicalRoot = await realpath(rootPath);

  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(request, response, 405, 'Method Not Allowed', {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8'
      });
      return;
    }

    let pathname;
    try {
      pathname = decodedPathname(request.url ?? '/');
    } catch {
      send(request, response, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (pathname.includes('\0') || pathname.split('/').includes('..')) {
      send(request, response, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    let target = resolve(rootPath, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
    if (!isInside(rootPath, target)) {
      send(request, response, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    try {
      let targetInfo = await stat(target);
      if (targetInfo.isDirectory()) {
        target = resolve(target, 'index.html');
        targetInfo = await stat(target);
      }
      if (!targetInfo.isFile()) {
        sendNotFound(request, response);
        return;
      }

      const canonicalTarget = await realpath(target);
      if (!isInside(canonicalRoot, canonicalTarget)) {
        send(request, response, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      const body = await readFile(canonicalTarget);
      send(request, response, 200, body, {
        'Content-Type': CONTENT_TYPES.get(extname(canonicalTarget).toLowerCase()) ?? 'application/octet-stream'
      });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        sendNotFound(request, response);
        return;
      }
      send(request, response, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  await new Promise((fulfill, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      fulfill();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((fulfill) => server.close(fulfill));
    throw new Error('Static site server did not expose a TCP address');
  }

  const displayHost = host.includes(':') ? `[${host}]` : host;
  let closed = false;
  return {
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close: () => new Promise((fulfill, reject) => {
      if (closed) {
        fulfill();
        return;
      }
      closed = true;
      server.close((error) => error ? reject(error) : fulfill());
    })
  };
}

function parseCli(arguments_) {
  let rootArgument;
  let portValue = process.env.PORT ?? '4173';
  let host = '127.0.0.1';

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--port') portValue = arguments_[++index];
    else if (argument === '--host') host = arguments_[++index];
    else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else if (rootArgument === undefined) rootArgument = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portValue}. Use a number from 0 to 65535.`);
  }
  if (!host) throw new Error('Host cannot be empty.');
  return { root: rootArgument ?? process.env.SITE_ROOT ?? DEFAULT_ROOT, port, host };
}

async function runCli() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
    const site = await startSiteServer(options);
    console.log(`Static site available at ${site.url}`);

    process.once('SIGINT', async () => {
      await site.close();
      process.exitCode = 0;
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      console.error(`Cannot preview the site: no static site directory exists at ${resolve(options?.root ?? DEFAULT_ROOT)}.`);
      console.error('Create that directory, pass a directory path, or set SITE_ROOT.');
    } else {
      console.error(`Cannot start the static site preview: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
