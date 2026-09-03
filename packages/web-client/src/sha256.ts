/** 浏览器与 Node 18+ 都有 WebCrypto；返回小写十六进制，与服务端 `createHash('sha256').digest('hex')` 同形。 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) out += (view[i] as number).toString(16).padStart(2, '0');
  return out;
}
