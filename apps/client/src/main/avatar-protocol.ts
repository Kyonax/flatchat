// SPDX-License-Identifier: MPL-2.0
// The flatchat-avatar:// protocol of spike S0.09's crowd bench (avatar-files.ts says what it serves).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { AVATAR_SCHEME, type AvatarFile, listAvatars, resolveAvatarRequest } from './avatar-files';

/** Before the app is ready: lets the page fetch from the scheme. */
export function registerAvatarScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: AVATAR_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

/** After the app is ready: serves the folder's listing and files. */
export function serveAvatars(dir: string): AvatarFile[] {
  const files = listAvatars(dir);
  const headers = { 'access-control-allow-origin': '*' };
  protocol.handle(AVATAR_SCHEME, async (request) => {
    const want = resolveAvatarRequest(request.url, files);
    if (!want) return new Response('not found', { status: 404, headers });
    if (want.kind === 'index') return new Response(JSON.stringify(files), { headers: { ...headers, 'content-type': 'application/json' } });
    const file = await net.fetch(pathToFileURL(join(dir, ...want.name.split('/'))).toString());
    return new Response(file.body, { status: file.status, headers: { ...headers, 'content-type': 'model/gltf-binary' } });
  });
  return files;
}
