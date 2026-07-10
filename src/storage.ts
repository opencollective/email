import fs from 'node:fs'
import path from 'node:path'
import { cfg } from './config.js'

/** Store an attachment blob. Returns a locator: a Vercel Blob URL when
 *  BLOB_READ_WRITE_TOKEN is configured (private store — downloads always go
 *  through the app), a local file path otherwise. */
export async function saveBlob(key: string, content: Buffer, contentType: string): Promise<string> {
  if (cfg.blobToken) {
    const { put } = await import('@vercel/blob')
    const res = await put(`attachments/${key}`, content, {
      access: 'private',
      addRandomSuffix: true,
      contentType,
    })
    return res.url
  }
  const p = path.join(cfg.dataDir, 'attachments', key)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

export async function readBlob(locator: string): Promise<Buffer | null> {
  if (/^https?:\/\//.test(locator)) {
    if (cfg.blobToken) {
      const { get } = await import('@vercel/blob')
      const res = await get(locator, { access: 'private' })
      if (!res) return null
      return Buffer.from(await new Response(res.stream).arrayBuffer())
    }
    const res = await fetch(locator)
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null
  }
  return fs.existsSync(locator) ? fs.readFileSync(locator) : null
}
