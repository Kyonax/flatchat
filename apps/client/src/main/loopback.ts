// SPDX-License-Identifier: MPL-2.0
// The loopback port a native app signs in through (RFC 8252, section 7.3). The client listens on
// 127.0.0.1 at a port the system picks; after the player signs in on the core's page, the browser
// is sent to http://127.0.0.1:PORT/callback?request=…&code=…, the client takes the code and shows
// a short page saying the player can go back to the app. Only that one request's callback counts.
import { createServer, type Server } from 'node:http';

const CODE = /^[A-Za-z0-9_-]{43}$/;

export interface Callback {
  code: string;
  lang: 'en' | 'es';
}

export interface Loopback {
  port: number;
  /** The login request this callback must name; until it is set, every callback is refused. */
  expect(request: string): void;
  /** The code, once the browser arrives; rejects on timeout or cancel. */
  result: Promise<Callback>;
  close(): void;
}

const PAGES = {
  en: { title: 'Signed in', body: 'You are signed in to FlatChat. You can close this tab and go back to the app.', other: 'This sign-in belongs to another FlatChat window.' },
  es: { title: 'Sesión iniciada', body: 'Iniciaste sesión en FlatChat. Puedes cerrar esta pestaña y volver a la aplicación.', other: 'Este inicio de sesión pertenece a otra ventana de FlatChat.' },
} as const;

function page(lang: 'en' | 'es', text: string, title: string): string {
  // Fixed text only: nothing from the request is written into the page.
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><p><strong>FlatChat</strong></p><p>${text}</p></body></html>`;
}

/** Listens for one sign-in's callback. The port comes first (the login request names it), so the
 *  request it must match is set afterwards with `expect`. */
export function listenForCallback(timeoutMs: number, signal?: AbortSignal): Promise<Loopback> {
  let expected = '';
  return new Promise((ready, fail) => {
    let settle: { resolve: (c: Callback) => void; reject: (e: Error) => void } | undefined;
    const result = new Promise<Callback>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const lang = url.searchParams.get('lang') === 'es' ? 'es' : 'en';
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" };
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404, headers).end(page(lang, '404', 'FlatChat'));
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      if (!expected || url.searchParams.get('request') !== expected || !CODE.test(code)) {
        res.writeHead(400, headers).end(page(lang, PAGES[lang].other, 'FlatChat'));
        return;
      }
      res.writeHead(200, headers).end(page(lang, PAGES[lang].body, PAGES[lang].title));
      settle?.resolve({ code, lang });
      close();
    });
    const close = (): void => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      settle?.reject(new Error('sign-in ended'));
    };
    signal?.addEventListener('abort', close, { once: true });
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        fail(new Error('no loopback port'));
        return;
      }
      timer = setTimeout(close, timeoutMs);
      ready({
        port: address.port,
        expect: (request) => {
          expected = request;
        },
        result,
        close,
      });
    });
  });
}
